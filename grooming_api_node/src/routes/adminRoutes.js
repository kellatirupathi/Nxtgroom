import { Router } from "express";
import { withMongoTransaction } from "../config/db.js";
import {
  getPasswordHash,
  idMatch,
  isElevated,
  requireRootAdmin,
  requireSuperAdmin,
  ROLES,
} from "../middleware/auth.js";
import { asyncRoute, createDocument, serializeDocument } from "../utils.js";
import {
  adminSchema,
  adminUpdateSchema,
  boaSchema,
  boaUpdateSchema,
  collegeSchema,
  setPasswordSchema,
  validate,
} from "../validation.js";
import {
  getNotificationSettings,
  saveNotificationSettings,
  validateNotificationSettings,
} from "../services/notificationSettings.js";
import {
  sendAccountCreatedEmail,
  sendAccountInviteEmail,
} from "../services/emailService.js";
import { INVITE_TTL_MS, issueResetToken } from "../services/passwordResetService.js";
import { appUrl } from "../config/env.js";

const COLLEGE_ASSIGNMENT_GUARD = "_private_assignment_guard_version";

export const adminRouter = Router();

/**
 * Tells a newly created administrator or BOA how to get in: an invitation
 * link when no password was set, otherwise a notice that one already exists.
 *
 * Never throws. The account is already committed by the time this runs, so a
 * mail failure must not turn a successful creation into an error; the caller
 * reports delivery through the `invited` / `emailed` flags instead.
 */
async function sendAccountSetupEmail(db, { email, name, role, hasPassword }) {
  try {
    if (hasPassword) {
      const result = await sendAccountCreatedEmail(email, {
        name,
        email,
        role,
        appUrl: appUrl(),
      });
      return { emailed: result.sent, invited: false, reason: result.reason };
    }

    const token = await issueResetToken(db, { email, kind: "invite", ttlMs: INVITE_TTL_MS });
    const result = await sendAccountInviteEmail(email, {
      name,
      role,
      appUrl: appUrl(),
      token,
      expiresInDays: Math.round(INVITE_TTL_MS / 86400000),
    });
    return { emailed: result.sent, invited: true, reason: result.reason };
  } catch (error) {
    console.error(`Account setup email failed for ${email}: ${error?.name || "Error"}`);
    return { emailed: false, invited: !hasPassword, reason: "send_failed" };
  }
}

function activeFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
    ],
  };
}

function activeUserFilter(extra = {}) {
  return {
    $and: [
      extra,
      { $or: [{ disabled_at: null }, { disabled_at: { $exists: false } }] },
    ],
  };
}

export function serializeAdminDocument(document) {
  const serialized = serializeDocument(document);
  for (const key of Object.keys(serialized)) {
    if (key.startsWith("_private_")) delete serialized[key];
  }
  return serialized;
}

export async function listActiveBoasWithAccounts(db) {
  const rows = await db.collection("boas")
    .find(activeFilter())
    .limit(1000)
    .toArray();
  if (!rows.length) return [];

  const referenceVariants = [];
  const seenVariants = new Set();
  for (const row of rows) {
    for (const variant of idMatch(String(row._id)).$in) {
      const key = `${variant?._bsontype || typeof variant}:${String(variant)}`;
      if (!seenVariants.has(key)) {
        seenVariants.add(key);
        referenceVariants.push(variant);
      }
    }
  }
  const accounts = await db.collection("users")
    .find(activeUserFilter({
      role: ROLES.BOA,
      reference_id: { $in: referenceVariants },
    }))
    .project({ reference_id: 1, email: 1 })
    .limit(1000)
    .toArray();
  const emailByReference = new Map(
    accounts.map((account) => [String(account.reference_id), account.email])
  );
  return rows
    .filter((row) => emailByReference.has(String(row._id)))
    // Records migrated from the previous cluster have no email on the BOA
    // document, only on the linked account, so the table showed "--". The
    // account is the authoritative address, so fall back to it.
    .map((row) => {
      if (row.email) return row;
      const accountEmail = emailByReference.get(String(row._id));
      // Leave the shape untouched when neither source has an address, rather
      // than introducing an explicit null the callers never had to handle.
      return accountEmail ? { ...row, email: accountEmail } : row;
    });
}

function invariantError(message) {
  const error = new Error(message);
  error.code = "TRANSACTION_INVARIANT_FAILED";
  return error;
}

export async function createBoaGuarded(
  db,
  input,
  passwordHash,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (await db.collection("users").findOne({ email: input.email }, { session })) {
      return { outcome: "duplicate_email" };
    }
    if (await db.collection("boas").findOne({ employee_id: input.employee_id }, { session })) {
      return { outcome: "duplicate_employee_id" };
    }

    const collegeGuard = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const boa = createDocument({
      employee_id: input.employee_id,
      name: input.name,
      college_id: String(college._id),
      email: input.email,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const user = createDocument({
      email: input.email,
      password_hash: passwordHash,
      role: ROLES.BOA,
      reference_id: boa._id,
      session_version: 1,
      created_at: now,
      updated_at: now,
    });
    await db.collection("boas").insertOne(boa, { session });
    await db.collection("users").insertOne(user, { session });
    return { outcome: "created", boa };
  });
}

export async function updateBoaGuarded(
  db,
  boaId,
  input,
  passwordHash,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const boa = await db.collection("boas").findOne(
      activeFilter({ _id: idMatch(boaId) }),
      { session }
    );
    if (!boa) return { outcome: "not_found" };
    const user = await db.collection("users").findOne(
      activeUserFilter({
        reference_id: idMatch(String(boa._id)),
        role: ROLES.BOA,
      }),
      { session }
    );
    if (!user) return { outcome: "account_unavailable" };
    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(input.college_id) }),
      { session }
    );
    if (!college) return { outcome: "college_not_found" };
    if (await db.collection("users").findOne(
      { email: input.email, _id: { $ne: user._id } },
      { session }
    )) {
      return { outcome: "duplicate_email" };
    }
    if (await db.collection("boas").findOne(
      { employee_id: input.employee_id, _id: { $ne: boa._id } },
      { session }
    )) {
      return { outcome: "duplicate_employee_id" };
    }

    const collegeGuard = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $inc: { [COLLEGE_ASSIGNMENT_GUARD]: 1 } },
      { session }
    );
    if (!collegeGuard.matchedCount) return { outcome: "college_not_found" };

    const now = new Date();
    const boaResult = await db.collection("boas").updateOne(
      activeFilter({ _id: boa._id }),
      {
        $set: {
          employee_id: input.employee_id,
          name: input.name,
          college_id: String(college._id),
          email: input.email,
          updated_at: now,
        },
      },
      { session }
    );
    const userSet = { email: input.email, updated_at: now };
    if (passwordHash) userSet.password_hash = passwordHash;
    const userResult = await db.collection("users").updateOne(
      { _id: user._id, role: ROLES.BOA },
      { $set: userSet, $inc: { session_version: 1 } },
      { session }
    );
    if (!boaResult.matchedCount || !userResult.matchedCount) {
      throw invariantError("BOA and user account could not be updated atomically");
    }
    return { outcome: "updated" };
  });
}

export async function deleteBoaGuarded(
  db,
  boaId,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const boa = await db.collection("boas").findOne(
      activeFilter({ _id: idMatch(boaId) }),
      { session }
    );
    if (!boa) return { outcome: "not_found" };
    const user = await db.collection("users").findOne(
      {
        reference_id: idMatch(String(boa._id)),
        role: ROLES.BOA,
      },
      { session }
    );
    if (!user) return { outcome: "account_unavailable" };

    const now = new Date();
    const boaResult = await db.collection("boas").updateOne(
      activeFilter({ _id: boa._id }),
      { $set: { deleted_at: now, updated_at: now } },
      { session }
    );
    const userResult = await db.collection("users").updateOne(
      { _id: user._id, role: ROLES.BOA },
      {
        $set: { disabled_at: now, updated_at: now },
        $inc: { session_version: 1 },
      },
      { session }
    );
    if (!boaResult.matchedCount || !userResult.matchedCount) {
      throw invariantError("BOA and user account could not be disabled atomically");
    }
    return { outcome: "deleted" };
  });
}

export async function updateCollegeGuarded(
  db,
  collegeId,
  input,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(collegeId) }),
      { session }
    );
    if (!college) return { outcome: "not_found" };
    if (await db.collection("colleges").findOne(
      { name: input.name, location: input.location, _id: { $ne: college._id } },
      { session }
    )) {
      return { outcome: "duplicate" };
    }
    const result = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $set: { ...input, updated_at: new Date() } },
      { session }
    );
    return result.matchedCount ? { outcome: "updated" } : { outcome: "not_found" };
  });
}

export async function deleteCollegeGuarded(
  db,
  collegeId,
  runTransaction = withMongoTransaction
) {
  return runTransaction(async (session) => {
    const college = await db.collection("colleges").findOne(
      activeFilter({ _id: idMatch(collegeId) }),
      { session }
    );
    if (!college) return { outcome: "not_found" };
    const collegeMatch = idMatch(String(college._id));
    if (await db.collection("boas").findOne(
      activeFilter({ college_id: collegeMatch }),
      { session }
    )) {
      return { outcome: "assigned_boa" };
    }
    if (await db.collection("instructors").findOne(
      activeFilter({ college_id: collegeMatch }),
      { session }
    )) {
      return { outcome: "assigned_instructor" };
    }

    const now = new Date();
    const result = await db.collection("colleges").updateOne(
      activeFilter({ _id: college._id }),
      { $set: { deleted_at: now, updated_at: now } },
      { session }
    );
    return result.matchedCount ? { outcome: "deleted" } : { outcome: "not_found" };
  });
}

function duplicateErrorResponse(error, res, detail) {
  if (error.code !== 11000) return false;
  res.status(409).json({ detail });
  return true;
}

adminRouter.post(
  "/boas",
  requireSuperAdmin,
  validate(boaSchema),
  asyncRoute(async (req, res) => {
    // No password means the BOA is invited to choose their own; the account is
    // stored without a hash, which verifyPassword() already refuses to match.
    const hasPassword = Boolean(req.validatedBody.password);
    const passwordHash = hasPassword
      ? await getPasswordHash(req.validatedBody.password)
      : null;
    let result;
    try {
      result = await createBoaGuarded(
        req.app.locals.db,
        req.validatedBody,
        passwordHash
      );
    } catch (error) {
      if (duplicateErrorResponse(error, res, "Email or employee ID already exists")) return;
      throw error;
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_email") {
      return res.status(400).json({ detail: "Email already registered" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Employee ID already exists" });
    }
    const delivery = await sendAccountSetupEmail(req.app.locals.db, {
      email: req.validatedBody.email,
      name: req.validatedBody.name,
      role: ROLES.BOA,
      hasPassword,
    });
    return res.status(201).json({
      message: "BOA created successfully",
      id: result.boa._id,
      ...delivery,
    });
  })
);

adminRouter.get(
  "/boas",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const rows = await listActiveBoasWithAccounts(req.app.locals.db);
    return res.json(rows.map(serializeAdminDocument));
  })
);

adminRouter.put(
  "/boas/:boaId",
  requireSuperAdmin,
  validate(boaUpdateSchema),
  asyncRoute(async (req, res) => {
    const passwordHash = req.validatedBody.password
      ? await getPasswordHash(req.validatedBody.password)
      : null;
    let result;
    try {
      result = await updateBoaGuarded(
        req.app.locals.db,
        req.params.boaId,
        req.validatedBody,
        passwordHash
      );
    } catch (error) {
      if (duplicateErrorResponse(error, res, "Email or employee ID already exists")) return;
      throw error;
    }
    if (result.outcome === "not_found") return res.status(404).json({ detail: "BOA not found" });
    if (result.outcome === "account_unavailable") {
      return res.status(409).json({ detail: "BOA user account is unavailable" });
    }
    if (result.outcome === "college_not_found") {
      return res.status(400).json({ detail: "Selected college does not exist" });
    }
    if (result.outcome === "duplicate_email") {
      return res.status(400).json({ detail: "Email already registered" });
    }
    if (result.outcome === "duplicate_employee_id") {
      return res.status(400).json({ detail: "Employee ID already exists" });
    }
    return res.json({ message: "BOA updated successfully" });
  })
);

adminRouter.delete(
  "/boas/:boaId",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await deleteBoaGuarded(req.app.locals.db, req.params.boaId);
    if (result.outcome === "not_found") return res.status(404).json({ detail: "BOA not found" });
    if (result.outcome === "account_unavailable") {
      return res.status(409).json({ detail: "BOA user account is unavailable" });
    }
    return res.json({ message: "BOA deleted successfully" });
  })
);

adminRouter.post(
  "/colleges",
  requireSuperAdmin,
  validate(collegeSchema),
  asyncRoute(async (req, res) => {
    const now = new Date();
    const college = createDocument({
      ...req.validatedBody,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    try {
      await req.app.locals.db.collection("colleges").insertOne(college);
    } catch (error) {
      if (duplicateErrorResponse(error, res, "A college with this name and location already exists")) return;
      throw error;
    }
    return res.status(201).json({ message: "College created successfully", id: college._id });
  })
);

adminRouter.get(
  "/colleges",
  asyncRoute(async (req, res) => {
    // Administrators are not tied to a college, so scoping them by collegeId
    // returned nothing and every table rendered "Unknown college".
    const scope = isElevated(req.currentUser.role)
      ? {}
      : { _id: idMatch(req.currentUser.collegeId) };
    const rows = await req.app.locals.db.collection("colleges")
      .find(activeFilter(scope))
      .limit(1000)
      .toArray();
    return res.json(rows.map(serializeAdminDocument));
  })
);

adminRouter.put(
  "/colleges/:collegeId",
  requireSuperAdmin,
  validate(collegeSchema),
  asyncRoute(async (req, res) => {
    let result;
    try {
      result = await updateCollegeGuarded(
        req.app.locals.db,
        req.params.collegeId,
        req.validatedBody
      );
    } catch (error) {
      if (duplicateErrorResponse(error, res, "A college with this name and location already exists")) return;
      throw error;
    }
    if (result.outcome === "not_found") return res.status(404).json({ detail: "College not found" });
    if (result.outcome === "duplicate") {
      return res.status(409).json({ detail: "A college with this name and location already exists" });
    }
    return res.json({ message: "College updated successfully" });
  })
);

adminRouter.delete(
  "/colleges/:collegeId",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = await deleteCollegeGuarded(req.app.locals.db, req.params.collegeId);
    if (result.outcome === "not_found") return res.status(404).json({ detail: "College not found" });
    if (result.outcome === "assigned_boa") {
      return res.status(409).json({ detail: "Reassign or delete active BOAs before deleting this college" });
    }
    if (result.outcome === "assigned_instructor") {
      return res.status(409).json({ detail: "Reassign or delete active instructors before deleting this college" });
    }
    return res.json({ message: "College deleted successfully" });
  })
);

adminRouter.get(
  "/settings/notifications",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const settings = await getNotificationSettings(req.app.locals.db);
    return res.json(settings);
  })
);

adminRouter.put(
  "/settings/notifications",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const result = validateNotificationSettings(req.body);
    if (!result.valid) return res.status(422).json({ detail: result.detail });
    const saved = await saveNotificationSettings(
      req.app.locals.db,
      result.value,
      req.currentUser.email
    );
    return res.json(saved);
  })
);

/* ---------------------------------------------------------------------------
 * Administrator accounts
 *
 * Only SUPER_ADMIN may reach these routes. ADMIN accounts hold organisation-
 * wide power everywhere else, but cannot create or remove each other, so the
 * owner can never be locked out of their own system.
 * ------------------------------------------------------------------------- */

function serializeUser(user) {
  return {
    _id: String(user._id),
    name: user.name || "",
    email: user.email,
    role: user.role,
    created_at: user.created_at || null,
    disabled_at: user.disabled_at || null,
  };
}

adminRouter.get(
  "/admins",
  requireRootAdmin,
  asyncRoute(async (req, res) => {
    const users = await req.app.locals.db
      .collection("users")
      .find({ role: { $in: [ROLES.SUPER_ADMIN, ROLES.ADMIN] } })
      .sort({ created_at: 1 })
      .toArray();
    return res.json(users.map(serializeUser));
  })
);

adminRouter.post(
  "/admins",
  requireRootAdmin,
  validate(adminSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const { name, email, password } = req.validatedBody;

    if (await db.collection("users").findOne({ email })) {
      return res.status(400).json({ detail: "Email already registered" });
    }

    // A blank password creates a pending account that can only be opened via
    // the emailed invitation link.
    const hasPassword = Boolean(password);
    const now = new Date();
    const user = createDocument({
      name,
      email,
      password_hash: hasPassword ? await getPasswordHash(password) : null,
      role: ROLES.ADMIN,
      reference_id: null,
      session_version: 0,
      created_at: now,
      updated_at: now,
    });

    try {
      await db.collection("users").insertOne(user);
    } catch (error) {
      if (duplicateErrorResponse(error, res, "Email already registered")) return;
      throw error;
    }
    const delivery = await sendAccountSetupEmail(db, {
      email,
      name,
      role: ROLES.ADMIN,
      hasPassword,
    });
    return res.status(201).json({
      message: "Administrator created successfully",
      id: user._id,
      ...delivery,
    });
  })
);

adminRouter.put(
  "/admins/:id",
  requireRootAdmin,
  validate(adminUpdateSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const { name, email, password } = req.validatedBody;
    const target = await db.collection("users").findOne({ _id: idMatch(String(req.params.id)) });

    if (!target || ![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(target.role)) {
      return res.status(404).json({ detail: "Administrator not found" });
    }

    const clash = await db.collection("users").findOne({ email, _id: { $ne: target._id } });
    if (clash) return res.status(400).json({ detail: "Email already registered" });

    const update = { name, email, updated_at: new Date() };
    const inc = {};
    if (password) {
      update.password_hash = await getPasswordHash(password);
      update.password_changed_at = new Date();
      // Force re-authentication everywhere when a credential changes.
      inc.session_version = 1;
    }
    // Changing the sign-in address must also invalidate existing tokens,
    // whose `sub` claim still carries the old address.
    if (email !== target.email) inc.session_version = 1;

    await db.collection("users").updateOne(
      { _id: target._id },
      Object.keys(inc).length ? { $set: update, $inc: inc } : { $set: update }
    );
    return res.json({ message: "Administrator updated successfully" });
  })
);

adminRouter.post(
  "/admins/:id/password",
  requireRootAdmin,
  validate(setPasswordSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const target = await db.collection("users").findOne({ _id: idMatch(String(req.params.id)) });
    if (!target || ![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(target.role)) {
      return res.status(404).json({ detail: "Administrator not found" });
    }

    await db.collection("users").updateOne(
      { _id: target._id },
      {
        $set: {
          password_hash: await getPasswordHash(req.validatedBody.new_password),
          password_changed_at: new Date(),
          updated_at: new Date(),
        },
        $inc: { session_version: 1 },
      }
    );
    return res.json({ message: "Password updated. The administrator must sign in again." });
  })
);

adminRouter.delete(
  "/admins/:id",
  requireRootAdmin,
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const target = await db.collection("users").findOne({ _id: idMatch(String(req.params.id)) });

    if (!target || ![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(target.role)) {
      return res.status(404).json({ detail: "Administrator not found" });
    }
    if (target.role === ROLES.SUPER_ADMIN) {
      return res.status(400).json({ detail: "The super admin account cannot be deleted" });
    }
    if (target.email === req.currentUser.email) {
      return res.status(400).json({ detail: "You cannot delete your own account" });
    }

    await db.collection("users").deleteOne({ _id: target._id });
    return res.json({ message: "Administrator deleted successfully" });
  })
);

/** Lets an elevated user set a BOA's password without knowing the old one. */
adminRouter.post(
  "/boas/:id/password",
  requireSuperAdmin,
  validate(setPasswordSchema),
  asyncRoute(async (req, res) => {
    const db = req.app.locals.db;
    const boa = await db.collection("boas").findOne(
      activeFilter({ _id: idMatch(String(req.params.id)) })
    );
    if (!boa) return res.status(404).json({ detail: "BOA not found" });

    const result = await db.collection("users").updateOne(
      activeUserFilter({ reference_id: String(boa._id), role: ROLES.BOA }),
      {
        $set: {
          password_hash: await getPasswordHash(req.validatedBody.new_password),
          password_changed_at: new Date(),
          updated_at: new Date(),
        },
        $inc: { session_version: 1 },
      }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ detail: "No active sign-in account for this BOA" });
    }
    return res.json({ message: "Password updated. The BOA must sign in again." });
  })
);

import { Router } from "express";
import { withMongoTransaction } from "../config/db.js";
import { getPasswordHash, idMatch, requireSuperAdmin, ROLES } from "../middleware/auth.js";
import { asyncRoute, createDocument, serializeDocument } from "../utils.js";
import { boaSchema, boaUpdateSchema, collegeSchema, validate } from "../validation.js";
import {
  getNotificationSettings,
  saveNotificationSettings,
  validateNotificationSettings,
} from "../services/notificationSettings.js";

const COLLEGE_ASSIGNMENT_GUARD = "_private_assignment_guard_version";

export const adminRouter = Router();

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
    .project({ reference_id: 1 })
    .limit(1000)
    .toArray();
  const activeReferences = new Set(accounts.map((account) => String(account.reference_id)));
  return rows.filter((row) => activeReferences.has(String(row._id)));
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
    const passwordHash = await getPasswordHash(req.validatedBody.password);
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
    return res.status(201).json({ message: "BOA created successfully", id: result.boa._id });
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
    const scope = req.currentUser.role === ROLES.SUPER_ADMIN
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

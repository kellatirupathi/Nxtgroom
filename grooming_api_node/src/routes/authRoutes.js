import { Router } from "express";
import { runtimeConfig } from "../config/env.js";
import {
  createAccessToken,
  getCurrentUser,
  getPasswordHash,
  ROLES,
  userSessionVersion,
  verifyPassword,
} from "../middleware/auth.js";
import { asyncRoute } from "../utils.js";
import {
  googleClientId,
  isGoogleLoginEnabled,
  verifyGoogleIdToken,
} from "../services/googleAuth.js";
import rateLimit from "express-rate-limit";

// Credential verification is a network call to Google; rate limit it so a
// flood of forged tokens cannot exhaust the request budget.
const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { detail: "Too many sign-in attempts. Please try again later." },
});

export const authRouter = Router();

authRouter.get("/me", getCurrentUser, (req, res) => {
  res.json({
    email: req.currentUser.email,
    role: req.currentUser.role,
    college_id: req.currentUser.collegeId,
  });
});

authRouter.post(
  "/login",
  asyncRoute(async (req, res) => {
    const email = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password || email.length > 254 || password.length > 128) {
      return res.status(422).json({ detail: "Username and password are required" });
    }

    const user = await req.app.locals.db.collection("users").findOne({ email });
    if (
      !user
      || user.disabled_at
      || !Object.values(ROLES).includes(user.role)
      || !(await verifyPassword(password, user.password_hash))
    ) {
      return res.status(401).json({ detail: "Incorrect email or password" });
    }

    return res.json({
      access_token: createAccessToken({
        sub: user.email,
        role: user.role,
        sessionVersion: userSessionVersion(user),
      }),
      token_type: "bearer",
      role: user.role,
      expires_in: 60 * runtimeConfig().jwtExpiresMinutes,
    });
  })
);

authRouter.post(
  "/change-password",
  getCurrentUser,
  asyncRoute(async (req, res) => {
    const currentPassword = String(req.body?.current_password || "");
    const newPassword = String(req.body?.new_password || "");

    if (!currentPassword || !newPassword) {
      return res.status(422).json({ detail: "Current and new passwords are required" });
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
      return res.status(422).json({ detail: "New password must be between 12 and 128 characters" });
    }
    if (newPassword === currentPassword) {
      return res.status(422).json({ detail: "New password must differ from the current password" });
    }

    const db = req.app.locals.db;
    const user = await db.collection("users").findOne({ email: req.currentUser.email });
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(401).json({ detail: "Current password is incorrect" });
    }

    // Bumping session_version invalidates every existing token for this user,
    // including the one making this request, so a stolen token cannot survive
    // a password change.
    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          password_hash: await getPasswordHash(newPassword),
          password_changed_at: new Date(),
          updated_at: new Date(),
        },
        $inc: { session_version: 1 },
      }
    );

    return res.json({ message: "Password changed successfully. Please sign in again." });
  })
);

/** Advertises whether the Google button should render, so the UI never shows a dead control. */
authRouter.get("/google/config", (_req, res) => {
  res.json({ enabled: isGoogleLoginEnabled(), client_id: googleClientId() || null });
});

/**
 * Sign-in only. A verified Google address must already belong to an active
 * user; this route never provisions accounts, so administrators keep sole
 * control of who exists via BOA management.
 */
authRouter.post(
  "/google",
  googleLoginLimiter,
  asyncRoute(async (req, res) => {
    if (!isGoogleLoginEnabled()) {
      return res.status(503).json({ detail: "Google sign-in is not enabled" });
    }

    const verification = await verifyGoogleIdToken(req.body?.credential);
    if (verification.error) {
      return res.status(401).json({ detail: verification.error });
    }

    const user = await req.app.locals.db
      .collection("users")
      .findOne({ email: verification.email });

    // One message for "no such user", "disabled", and "bad role" so the
    // endpoint cannot be used to enumerate which emails hold accounts.
    if (!user || user.disabled_at || !Object.values(ROLES).includes(user.role)) {
      return res.status(403).json({
        detail: "This Google account is not authorised. Ask an administrator to add it first.",
      });
    }

    return res.json({
      access_token: createAccessToken({
        sub: user.email,
        role: user.role,
        sessionVersion: userSessionVersion(user),
      }),
      token_type: "bearer",
      role: user.role,
      expires_in: 60 * runtimeConfig().jwtExpiresMinutes,
    });
  })
);

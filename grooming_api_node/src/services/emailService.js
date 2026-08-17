import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { runtimeConfig } from "../config/env.js";

const DEFAULT_TIME_ZONE = "Asia/Kolkata";
let sesClient = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(value) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: process.env.APP_TIME_ZONE || DEFAULT_TIME_ZONE,
  }).format(parsed);
}

function displayStatus(status, requiresHumanReview = false) {
  const normalized = String(status || "").toLowerCase();
  if (["review_required", "needs_review"].includes(normalized)) return "REVIEW REQUIRED";
  if (["compliant", "done"].includes(normalized)) {
    return requiresHumanReview ? "REVIEW REQUIRED" : "COMPLIANT";
  }
  if (["non_compliant", "non-compliant", "fail"].includes(normalized)) return "NON-COMPLIANT";
  if (["error", "analysis_error"].includes(normalized)) return "ANALYSIS UNAVAILABLE";
  return "AI ANALYSIS PENDING";
}

function reviewNotice(status, requiresHumanReview = false) {
  return requiresHumanReview
    || status === "REVIEW REQUIRED"
    || status === "NON-COMPLIANT"
    || status === "ANALYSIS UNAVAILABLE"
    ? "This automated report requires administrator review before any action is taken."
    : "This is an automated, assistive grooming report.";
}

export function buildEvaluationEmail({
  instructorName,
  overallStatus,
  aiSummary,
  checkInTime,
  requiresHumanReview = false,
  imageQuality,
}) {
  const name = instructorName || "Instructor";
  const status = displayStatus(overallStatus, requiresHumanReview);
  const summary = aiSummary || "No additional observations were provided.";
  const checkIn = formatDateTime(checkInTime);
  const notice = reviewNotice(status, requiresHumanReview);
  const qualityLine = imageQuality === "RETAKE_RECOMMENDED"
    ? "Image quality: A clearer full-body photo is recommended."
    : null;
  const introduction = status === "ANALYSIS UNAVAILABLE"
    ? "Your check-in photo could not be analysed."
    : "Your check-in photo has been analysed.";

  return {
    subject: "Your check-in grooming report",
    text: [
      `Hello ${name},`,
      "",
      introduction,
      `Check-in: ${checkIn}`,
      `Grooming status: ${status}`,
      `Summary: ${summary}`,
      ...(qualityLine ? [qualityLine] : []),
      notice,
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(name)},</p>
      <p>${escapeHtml(introduction)}</p>
      <p>
        <strong>Check-in:</strong> ${escapeHtml(checkIn)}<br>
        <strong>Grooming status:</strong> ${escapeHtml(status)}<br>
        <strong>Summary:</strong> ${escapeHtml(summary)}
      </p>
      ${qualityLine ? `<p>${escapeHtml(qualityLine)}</p>` : ""}
      <p>${escapeHtml(notice)}</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

export function buildCheckoutEmail({
  instructorName,
  checkInTime,
  checkOutTime,
  status,
  remarks,
  requiresHumanReview = false,
  imageQuality,
}) {
  const name = instructorName || "Instructor";
  const reportStatus = displayStatus(status, requiresHumanReview);
  const summary = remarks || "No additional observations were provided.";
  const checkIn = formatDateTime(checkInTime);
  const checkOut = formatDateTime(checkOutTime);
  const notice = reviewNotice(reportStatus, requiresHumanReview);
  const qualityLine = imageQuality === "RETAKE_RECOMMENDED"
    ? "Image quality: A clearer full-body photo is recommended."
    : null;

  return {
    subject: "Checkout confirmation and grooming summary",
    text: [
      `Hello ${name},`,
      "",
      "Your checkout has been recorded successfully.",
      `Check-in: ${checkIn}`,
      `Check-out: ${checkOut}`,
      `Grooming status: ${reportStatus}`,
      `Summary: ${summary}`,
      ...(qualityLine ? [qualityLine] : []),
      notice,
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(name)},</p>
      <p>Your checkout has been recorded successfully.</p>
      <p>
        <strong>Check-in:</strong> ${escapeHtml(checkIn)}<br>
        <strong>Check-out:</strong> ${escapeHtml(checkOut)}<br>
        <strong>Grooming status:</strong> ${escapeHtml(reportStatus)}<br>
        <strong>Summary:</strong> ${escapeHtml(summary)}
      </p>
      ${qualityLine ? `<p>${escapeHtml(qualityLine)}</p>` : ""}
      <p>${escapeHtml(notice)}</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

function getSesConfig() {
  return {
    region: process.env.AWS_REGION,
    fromEmail: process.env.SES_FROM_EMAIL,
    configurationSet: process.env.SES_CONFIGURATION_SET,
  };
}

// Cache per region: a cached client built for a previous region would keep
// sending to that region after the configured region changes.
function getSesClient(config) {
  if (!sesClient || sesClient.__region !== config.region) {
    sesClient = new SESClient({
      region: config.region,
      maxAttempts: runtimeConfig().sesMaxAttempts,
    });
    sesClient.__region = config.region;
  }
  return sesClient;
}

async function sendEmail(toEmail, content) {
  if (!toEmail) return { sent: false, reason: "missing_recipient" };
  const config = getSesConfig();
  if (!config.region || !config.fromEmail) {
    console.warn("AWS SES is not fully configured; email was not sent.");
    return { sent: false, reason: "ses_not_configured" };
  }

  try {
    const input = {
      Source: config.fromEmail,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Charset: "UTF-8", Data: content.subject },
        Body: {
          Text: { Charset: "UTF-8", Data: content.text },
          Html: { Charset: "UTF-8", Data: content.html },
        },
      },
    };
    if (config.configurationSet) input.ConfigurationSetName = config.configurationSet;
    const response = await getSesClient(config).send(
      new SendEmailCommand(input),
      { abortSignal: AbortSignal.timeout(runtimeConfig().sesTimeoutMs) }
    );
    console.log(`AWS SES email accepted. Message ID: ${response.MessageId || "unavailable"}`);
    return { sent: true, messageId: response.MessageId };
  } catch (error) {
    console.error(`AWS SES email failed: ${error.name || "Error"}`);
    return { sent: false, reason: error.name || "ses_error" };
  }
}

export function sendEvaluationEmail(toEmail, report) {
  return sendEmail(toEmail, buildEvaluationEmail(report));
}

export function sendCheckoutEmail(toEmail, report) {
  return sendEmail(toEmail, buildCheckoutEmail(report));
}

const ROLE_LABELS = {
  SUPER_ADMIN: "Super Administrator",
  ADMIN: "Administrator",
  BOA: "BOA",
};

function roleLabel(role) {
  return ROLE_LABELS[role] || "user";
}

/**
 * Invitation for an account created without a password. The link is the only
 * way in, so it is stated plainly along with when it stops working.
 */
export function buildAccountInviteEmail({ name, role, appUrl, token, expiresInDays = 7 }) {
  const person = name || "there";
  const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const expiry = `This link expires in ${expiresInDays} days and can be used once.`;

  return {
    subject: "Your FacultyTrack account - set your password",
    text: [
      `Hello ${person},`,
      "",
      `A FacultyTrack account has been created for you as a ${roleLabel(role)}.`,
      "",
      "Choose your password to activate the account:",
      link,
      "",
      expiry,
      "If you were not expecting this email, you can ignore it.",
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(person)},</p>
      <p>A FacultyTrack account has been created for you as a <strong>${escapeHtml(roleLabel(role))}</strong>.</p>
      <p><a href="${escapeHtml(link)}">Choose your password to activate the account</a></p>
      <p style="color:#475569;font-size:13px">${escapeHtml(expiry)}<br>If you were not expecting this email, you can ignore it.</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

/**
 * Sent when an administrator sets the password themselves. The password is
 * deliberately not included: it was chosen by someone else, and email is not
 * a safe channel for it.
 */
export function buildAccountCreatedEmail({ name, email, role, appUrl }) {
  const person = name || "there";
  const signIn = `${appUrl}/`;

  return {
    subject: "Your FacultyTrack account is ready",
    text: [
      `Hello ${person},`,
      "",
      `A FacultyTrack account has been created for you as a ${roleLabel(role)}.`,
      `Sign in with your email: ${email}`,
      "",
      `An administrator has set your initial password. ${signIn}`,
      "",
      "If you do not have it, use \"Forgot password\" on the sign-in page to set your own.",
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(person)},</p>
      <p>A FacultyTrack account has been created for you as a <strong>${escapeHtml(roleLabel(role))}</strong>.</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}<br>
      An administrator has set your initial password.</p>
      <p><a href="${escapeHtml(signIn)}">Sign in to FacultyTrack</a></p>
      <p style="color:#475569;font-size:13px">If you do not have your password, use &quot;Forgot password&quot; on the sign-in page to set your own.</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

/** Self-service reset. Short-lived because it is triggered by an anonymous request. */
export function buildPasswordResetEmail({ name, appUrl, token, expiresInMinutes = 60 }) {
  const person = name || "there";
  const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const expiry = `This link expires in ${expiresInMinutes} minutes and can be used once.`;

  return {
    subject: "Reset your FacultyTrack password",
    text: [
      `Hello ${person},`,
      "",
      "We received a request to reset your FacultyTrack password.",
      "",
      "Choose a new password:",
      link,
      "",
      expiry,
      "If you did not request this, ignore this email. Your password will not change.",
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(person)},</p>
      <p>We received a request to reset your FacultyTrack password.</p>
      <p><a href="${escapeHtml(link)}">Choose a new password</a></p>
      <p style="color:#475569;font-size:13px">${escapeHtml(expiry)}<br>If you did not request this, ignore this email. Your password will not change.</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

export function sendAccountInviteEmail(toEmail, payload) {
  return sendEmail(toEmail, buildAccountInviteEmail(payload));
}

export function sendAccountCreatedEmail(toEmail, payload) {
  return sendEmail(toEmail, buildAccountCreatedEmail(payload));
}

export function sendPasswordResetEmail(toEmail, payload) {
  return sendEmail(toEmail, buildPasswordResetEmail(payload));
}

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

function displayStatus(status) {
  const normalized = String(status || "").toLowerCase();
  // review_required is still read, never written: records evaluated before the
  // review flag was removed keep it, and their emails must not read "pending".
  if (["compliant", "done", "review_required", "needs_review"].includes(normalized)) {
    return "COMPLIANT";
  }
  if (["non_compliant", "non-compliant", "fail"].includes(normalized)) return "NON-COMPLIANT";
  if (["error", "analysis_error"].includes(normalized)) return "ANALYSIS UNAVAILABLE";
  return "AI ANALYSIS PENDING";
}

function reviewNotice(status) {
  return status === "NON-COMPLIANT" || status === "ANALYSIS UNAVAILABLE"
    ? "This is an automated, assistive appearance report. Please review the detail before acting on it."
    : "This is an automated, assistive appearance report.";
}

export function buildEvaluationEmail({
  instructorName,
  overallStatus,
  aiSummary,
  checkInTime,
  imageQuality,
}) {
  const name = instructorName || "Instructor";
  const status = displayStatus(overallStatus);
  const summary = aiSummary || "No additional observations were provided.";
  const checkIn = formatDateTime(checkInTime);
  const notice = reviewNotice(status);
  const qualityLine = imageQuality === "RETAKE_RECOMMENDED"
    ? "Image quality: A clearer full-body photo is recommended."
    : null;
  const introduction = status === "ANALYSIS UNAVAILABLE"
    ? "Your check-in photo could not be analysed."
    : "Your check-in photo has been analysed.";

  return {
    subject: "Your check-in appearance report",
    text: [
      `Hello ${name},`,
      "",
      introduction,
      `Check-in: ${checkIn}`,
      `Appearance status: ${status}`,
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
        <strong>Appearance status:</strong> ${escapeHtml(status)}<br>
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
  imageQuality,
}) {
  const name = instructorName || "Instructor";
  const reportStatus = displayStatus(status);
  const summary = remarks || "No additional observations were provided.";
  const checkIn = formatDateTime(checkInTime);
  const checkOut = formatDateTime(checkOutTime);
  const notice = reviewNotice(reportStatus);
  const qualityLine = imageQuality === "RETAKE_RECOMMENDED"
    ? "Image quality: A clearer full-body photo is recommended."
    : null;

  return {
    subject: "Checkout confirmation and appearance summary",
    text: [
      `Hello ${name},`,
      "",
      "Your checkout has been recorded successfully.",
      `Check-in: ${checkIn}`,
      `Check-out: ${checkOut}`,
      `Appearance status: ${reportStatus}`,
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
        <strong>Appearance status:</strong> ${escapeHtml(reportStatus)}<br>
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

function dayLabel(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function statusLabel(day) {
  if (!day.present) return "No check-in";
  if (day.status === "compliant") return "Compliant";
  if (day.status === "non_compliant") return "Non-compliant";
  if (day.status === "error") return "Analysis error";
  return "Pending";
}

const ATTIRE_LABELS = {
  FORMAL: "Formal",
  SAREE: "Saree",
  KURTI_WITH_DUPATTA: "Kurti with dupatta",
};

/** Weekly summary with a link to the instructor's own report page. */
export function buildWeeklyReportEmail({ name, summary, reportUrl }) {
  const person = name || "there";
  const range = `${dayLabel(summary.week_start)} to ${dayLabel(summary.week_end)}`;
  const rows = summary.days.map((day) => ({
    label: dayLabel(day.date),
    status: statusLabel(day),
    attire: day.present ? (ATTIRE_LABELS[day.attire_type] || "Not identified") : "-",
  }));

  const textRows = rows
    .map((row) => `  ${row.label.padEnd(14)} ${row.status.padEnd(18)} ${row.attire}`)
    .join("\n");
  const htmlRows = rows
    .map((row) => `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escapeHtml(row.label)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escapeHtml(row.status)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escapeHtml(row.attire)}</td>
      </tr>`)
    .join("");

  return {
    subject: `Your appearance summary for ${range}`,
    text: [
      `Hello ${person},`,
      "",
      `Here is your appearance summary for ${range}.`,
      "",
      `Days present: ${summary.present_days} of 6`,
      `Compliant: ${summary.compliant_days} | Needs review: ${summary.review_days} | Non-compliant: ${summary.non_compliant_days}`,
      `Attire: formal ${summary.formal_days}, saree ${summary.saree_days}, kurti ${summary.kurti_days}`,
      ...(summary.missed_checkouts ? [`Missed check-outs: ${summary.missed_checkouts}`] : []),
      "",
      "Day by day:",
      textRows,
      "",
      "Full report:",
      reportUrl,
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(person)},</p>
      <p>Here is your appearance summary for <strong>${escapeHtml(range)}</strong>.</p>
      <p>
        Days present: <strong>${summary.present_days} of 6</strong><br>
        Compliant: ${summary.compliant_days} &middot; Needs review: ${summary.review_days} &middot; Non-compliant: ${summary.non_compliant_days}<br>
        Attire: formal ${summary.formal_days}, saree ${summary.saree_days}, kurti ${summary.kurti_days}
        ${summary.missed_checkouts ? `<br>Missed check-outs: ${summary.missed_checkouts}` : ""}
      </p>
      <table style="border-collapse:collapse;font-size:14px;margin:16px 0">
        <thead><tr style="background:#f1f5f9">
          <th style="padding:6px 10px;text-align:left">Day</th>
          <th style="padding:6px 10px;text-align:left">Result</th>
          <th style="padding:6px 10px;text-align:left">Attire</th>
        </tr></thead>
        <tbody>${htmlRows}</tbody>
      </table>
      <p><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">View your full report</a></p>
      <p style="color:#64748b;font-size:12px">This link is personal to you. Please do not forward it.</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

/** Sent as soon as an analysis finishes badly, to the instructor and the RPs. */
export function buildGroomingAlertEmail({ name, status, summary, dateLabel, reportUrl, forReviewer = false }) {
  const person = name || "Instructor";
  // Alerts only fire on a failure now that manual review is gone, but the
  // wording still handles the other case rather than asserting a status that
  // an older queued job might not have.
  const heading = status === "non_compliant"
    ? "did not meet the appearance standards"
    : "needs attention";
  const subject = forReviewer
    ? `Appearance alert: ${person} - ${dateLabel}`
    : `Your check-in on ${dateLabel} ${heading}`;

  const opening = forReviewer
    ? `${person}'s check-in on ${dateLabel} ${heading}.`
    : `Your check-in on ${dateLabel} ${heading}.`;

  return {
    subject,
    text: [
      forReviewer ? "Hello," : `Hello ${person},`,
      "",
      opening,
      "",
      summary || "See the full report for the checkpoint detail.",
      "",
      "Full report:",
      reportUrl,
      "",
      "This is an assistive screening result and should be reviewed before any action is taken.",
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>${forReviewer ? "Hello," : `Hello ${escapeHtml(person)},`}</p>
      <p>${escapeHtml(opening)}</p>
      <p style="background:#fff7ed;border-left:3px solid #f59e0b;padding:10px 14px">${escapeHtml(summary || "See the full report for the checkpoint detail.")}</p>
      <p><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">View the full report</a></p>
      <p style="color:#64748b;font-size:12px">This is an assistive screening result and should be reviewed before any action is taken.</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

/** Friendly nudge when a check-in or check-out was missed. */
export function buildAttendanceReminderEmail({ name, kind, dateLabel }) {
  const person = name || "there";
  const missedCheckout = kind === "checkout";
  const line = missedCheckout
    ? `It looks like you checked in on ${dateLabel} but did not check out.`
    : `It looks like you checked out on ${dateLabel} without a check-in recorded.`;
  const ask = missedCheckout
    ? "Please remember to check out at the end of the day so your attendance is complete."
    : "Please remember to check in at the start of the day so your attendance is complete.";

  return {
    subject: missedCheckout
      ? `Reminder: check-out missing for ${dateLabel}`
      : `Reminder: check-in missing for ${dateLabel}`,
    text: [
      `Hello ${person},`,
      "",
      line,
      ask,
      "",
      "No action is needed if this was intentional.",
      "",
      "Regards,",
      "NxtWave Administration",
    ].join("\n"),
    html: `
      <p>Hello ${escapeHtml(person)},</p>
      <p>${escapeHtml(line)}</p>
      <p>${escapeHtml(ask)}</p>
      <p style="color:#64748b;font-size:12px">No action is needed if this was intentional.</p>
      <p>Regards,<br>NxtWave Administration</p>
    `,
  };
}

export function sendWeeklyReportEmail(toEmail, payload) {
  return sendEmail(toEmail, buildWeeklyReportEmail(payload));
}

export function sendGroomingAlertEmail(toEmail, payload) {
  return sendEmail(toEmail, buildGroomingAlertEmail(payload));
}

export function sendAttendanceReminderEmail(toEmail, payload) {
  return sendEmail(toEmail, buildAttendanceReminderEmail(payload));
}

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

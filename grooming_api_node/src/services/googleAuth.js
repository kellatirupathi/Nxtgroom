import { OAuth2Client } from "google-auth-library";

let client = null;

export function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || "").trim();
}

export function isGoogleLoginEnabled() {
  return googleClientId().length > 0;
}

function getClient() {
  if (!client) client = new OAuth2Client(googleClientId());
  return client;
}

export async function verifyGoogleIdToken(idToken) {
  const clientId = googleClientId();
  if (!clientId) return { error: "Google sign-in is not configured" };
  if (typeof idToken !== "string" || idToken.length < 16 || idToken.length > 4096) {
    return { error: "Invalid Google credential" };
  }

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({ idToken, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    return { error: "Invalid Google credential" };
  }

  if (!payload) return { error: "Invalid Google credential" };
  if (payload.email_verified !== true) {
    return { error: "This Google account does not have a verified email address" };
  }

  const email = String(payload.email || "").trim().toLowerCase();
  if (!email || email.length > 254) return { error: "Invalid Google credential" };

  return { email };
}

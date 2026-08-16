const DEV_JWT_SECRET = "development-only-secret-change-before-production";
const EXAMPLE_JWT_SECRET = "replace-with-at-least-32-random-characters";
const EXAMPLE_ADMIN_PASSWORD = "replace-with-a-unique-password-of-at-least-12-characters";

function parseInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const normalized = raw == null ? "" : String(raw).trim();
  if (normalized && !/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`${name} must be a whole integer`);
  }
  const value = normalized === "" ? fallback : Number.parseInt(normalized, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function corsOrigins() {
  return (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function runtimeConfig() {
  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port: parseInteger("PORT", 8000, { min: 1, max: 65535 }),
    mongoUri: process.env.MONGODB_URI || "",
    dbName: process.env.DB_NAME || "grooming_standards",
    jwtSecret: process.env.SECRET_KEY || DEV_JWT_SECRET,
    jwtExpiresMinutes: parseInteger("JWT_EXPIRE_MINUTES", 480, { min: 5, max: 10080 }),
    jwtIssuer: process.env.JWT_ISSUER || "facultytrack-api",
    jwtAudience: process.env.JWT_AUDIENCE || "facultytrack-web",
    adminEmail: (process.env.ADMIN_EMAIL || "admin@nxtwave.com").trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD || "admin@123",
    adminPasswordVersion: process.env.ADMIN_PASSWORD_VERSION || "development-v1",
    origins: corsOrigins(),
    openAiTimeoutMs: parseInteger("OPENAI_TIMEOUT_MS", 120000, { min: 10000, max: 600000 }),
    openAiMaxRetries: parseInteger("OPENAI_MAX_RETRIES", 2, { min: 0, max: 2 }),
    evaluationPollMs: parseInteger("EVALUATION_POLL_MS", 2000, { min: 250, max: 60000 }),
    evaluationLeaseMs: parseInteger("EVALUATION_LEASE_MS", 600000, { min: 60000, max: 3600000 }),
    evaluationMaxAttempts: parseInteger("EVALUATION_MAX_ATTEMPTS", 3, { min: 1, max: 10 }),
    sesTimeoutMs: parseInteger("SES_TIMEOUT_MS", 30000, { min: 5000, max: 120000 }),
    sesMaxAttempts: parseInteger("SES_MAX_ATTEMPTS", 2, { min: 1, max: 3 }),
    notificationLeaseMs: parseInteger("NOTIFICATION_LEASE_MS", 300000, { min: 60000, max: 600000 }),
    notificationMaxAttempts: parseInteger("NOTIFICATION_MAX_ATTEMPTS", 5, { min: 1, max: 10 }),
    appTimeZone: process.env.APP_TIME_ZONE || "Asia/Kolkata",
    timezoneOffsetMinutes: parseInteger("TIMEZONE_OFFSET_MINUTES", 330, { min: -720, max: 840 }),
  };
}

export function validateEnvironment() {
  const config = runtimeConfig();
  if (!["development", "test", "production"].includes(config.nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  if (!isProduction()) return config;

  const errors = [];
  const required = [
    "MONGODB_URI",
    "DB_NAME",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_TIMEOUT_MS",
    "OPENAI_MAX_RETRIES",
    "EVALUATION_POLL_MS",
    "EVALUATION_LEASE_MS",
    "EVALUATION_MAX_ATTEMPTS",
    "SES_TIMEOUT_MS",
    "SES_MAX_ATTEMPTS",
    "NOTIFICATION_LEASE_MS",
    "NOTIFICATION_MAX_ATTEMPTS",
    "SECRET_KEY",
    "JWT_EXPIRE_MINUTES",
    "JWT_ISSUER",
    "JWT_AUDIENCE",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "ADMIN_PASSWORD_VERSION",
    "CORS_ORIGINS",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SES_FROM_EMAIL",
    "APP_TIME_ZONE",
    "TIMEZONE_OFFSET_MINUTES",
  ];
  for (const name of required) {
    if (!process.env[name]?.trim()) errors.push(`${name} is required`);
  }
  if (
    config.jwtSecret.length < 32
    || config.jwtSecret === DEV_JWT_SECRET
    || config.jwtSecret === EXAMPLE_JWT_SECRET
  ) {
    errors.push("SECRET_KEY must be a unique secret of at least 32 characters");
  }
  if (
    config.adminPassword.length < 12
    || config.adminPassword === "admin@123"
    || config.adminPassword === EXAMPLE_ADMIN_PASSWORD
  ) {
    errors.push("ADMIN_PASSWORD must be at least 12 characters and cannot use the development default");
  }
  if (config.adminPassword.toLowerCase().includes(config.adminEmail.split("@")[0])) {
    errors.push("ADMIN_PASSWORD cannot contain the administrator email name");
  }
  if (config.origins.includes("*")) {
    errors.push("CORS_ORIGINS cannot contain * in production");
  }
  if (config.origins.length === 0) {
    errors.push("CORS_ORIGINS must contain at least one exact HTTPS origin");
  }
  for (const origin of config.origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) {
        errors.push(`Production CORS origin must be an exact HTTPS origin: ${origin}`);
      }
    } catch {
      errors.push(`Production CORS origin is invalid: ${origin}`);
    }
  }
  if (config.mongoUri && !/^mongodb(?:\+srv)?:\/\//.test(config.mongoUri)) {
    errors.push("MONGODB_URI must start with mongodb:// or mongodb+srv://");
  } else if (config.mongoUri.startsWith("mongodb://")) {
    try {
      const uri = new URL(config.mongoUri);
      const tls = (uri.searchParams.get("tls") || uri.searchParams.get("ssl") || "").toLowerCase();
      if (tls !== "true") {
        errors.push("Production mongodb:// connections must explicitly set tls=true; prefer mongodb+srv://");
      }
    } catch {
      errors.push("MONGODB_URI is invalid");
    }
  } else if (config.mongoUri.startsWith("mongodb+srv://")) {
    try {
      const uri = new URL(config.mongoUri);
      const tls = (uri.searchParams.get("tls") || uri.searchParams.get("ssl") || "").toLowerCase();
      if (tls === "false") errors.push("MONGODB_URI cannot disable TLS in production");
    } catch {
      errors.push("MONGODB_URI is invalid");
    }
  }
  if (!/^gpt-4o-\d{4}-\d{2}-\d{2}$/.test(process.env.OPENAI_MODEL || "")) {
    errors.push("OPENAI_MODEL must use a pinned GPT-4o snapshot (for example gpt-4o-2024-11-20)");
  }
  const minimumEvaluationLease = config.openAiTimeoutMs * (config.openAiMaxRetries + 1) + 60000;
  if (config.evaluationLeaseMs < minimumEvaluationLease) {
    errors.push(
      `EVALUATION_LEASE_MS must be at least ${minimumEvaluationLease} for the configured OpenAI timeout and retries`
    );
  }
  if (config.notificationLeaseMs < config.sesTimeoutMs + 60000) {
    errors.push("NOTIFICATION_LEASE_MS must be at least SES_TIMEOUT_MS plus 60000");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) {
    errors.push("ADMIN_EMAIL must be a valid email address");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SES_FROM_EMAIL || "")) {
    errors.push("SES_FROM_EMAIL must be a valid email address");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: process.env.APP_TIME_ZONE }).format();
  } catch {
    errors.push("APP_TIME_ZONE must be a valid IANA time zone");
  }
  if (errors.length) {
    throw new Error(`Invalid production environment:\n- ${errors.join("\n- ")}`);
  }
  return config;
}

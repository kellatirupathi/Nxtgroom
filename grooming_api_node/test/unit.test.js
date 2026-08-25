import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import { appUrl, CORS_METHODS, runtimeConfig, validateEnvironment } from "../src/config/env.js";
import { createAccessToken } from "../src/middleware/auth.js";
import { detectImageMimeType, validateImageUpload } from "../src/imageValidation.js";
import { normalizeInstructorImage } from "../src/imageProcessor.js";
import { buildSystemPrompt } from "../src/prompts.js";
import { buildCheckoutEmail, buildEvaluationEmail } from "../src/services/emailService.js";
import { dateBoundsInTimeZone, parsePagination } from "../src/utils.js";
import { instructorGenderSchema, parseCoordinates } from "../src/validation.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name];
  }
  Object.assign(process.env, originalEnvironment);
});

test("production configuration fails closed when secrets are missing", () => {
  process.env.NODE_ENV = "production";
  for (const name of [
    "MONGODB_URI", "DB_NAME", "GEMINI_API_KEY", "GEMINI_MODEL", "SECRET_KEY",
    "JWT_EXPIRE_MINUTES", "JWT_ISSUER", "JWT_AUDIENCE", "ADMIN_EMAIL",
    "ADMIN_PASSWORD", "ADMIN_PASSWORD_VERSION", "CORS_ORIGINS", "AWS_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SES_FROM_EMAIL", "APP_TIME_ZONE",
    "TIMEZONE_OFFSET_MINUTES", "GEMINI_TIMEOUT_MS", "EVALUATION_POLL_MS",
    "EVALUATION_LEASE_MS", "EVALUATION_MAX_ATTEMPTS", "GEMINI_MAX_RETRIES",
    "GEMINI_EXPLICIT_CACHE", "GEMINI_CACHE_TTL_SECONDS",
    "SES_TIMEOUT_MS", "SES_MAX_ATTEMPTS", "NOTIFICATION_LEASE_MS",
    "NOTIFICATION_MAX_ATTEMPTS",
    "EVALUATION_CONCURRENCY", "CHECKIN_CONCURRENCY_LIMIT", "NOTIFICATION_CONCURRENCY",
    "APP_URL", "CRON_SECRET", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  ]) delete process.env[name];
  assert.throws(() => validateEnvironment(), /Invalid production environment/);
});

test("production configuration accepts an exact secure contract", () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    MONGODB_URI: "mongodb+srv://db.example.invalid/grooming_standards",
    DB_NAME: "grooming_standards",
    GEMINI_API_KEY: "test-only-gemini-key",
    GEMINI_MODEL: "gemini-2.5-flash-lite",
    GEMINI_TIMEOUT_MS: "120000",
    GEMINI_MAX_RETRIES: "2",
    GEMINI_EXPLICIT_CACHE: "true",
    GEMINI_CACHE_TTL_SECONDS: "3600",
    EVALUATION_POLL_MS: "2000",
    EVALUATION_LEASE_MS: "600000",
    EVALUATION_MAX_ATTEMPTS: "3",
    EVALUATION_CONCURRENCY: "2",
    CHECKIN_CONCURRENCY_LIMIT: "5",
    SECRET_KEY: "x".repeat(64),
    JWT_EXPIRE_MINUTES: "480",
    JWT_ISSUER: "facultytrack-api",
    JWT_AUDIENCE: "facultytrack-web",
    ADMIN_EMAIL: "admin@example.com",
    ADMIN_PASSWORD: "test-only-password-123",
    ADMIN_PASSWORD_VERSION: "test-v1",
    CORS_ORIGINS: "https://facultytrack.example.com",
    APP_URL: "https://facultytrack.example.com",
    CRON_SECRET: "test-only-cron-secret",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_BUCKET: "facultytrack-photos",
    R2_ACCESS_KEY_ID: "test-r2-access",
    R2_SECRET_ACCESS_KEY: "test-r2-secret",
    AWS_REGION: "ap-south-1",
    AWS_ACCESS_KEY_ID: "test-only-access-key",
    AWS_SECRET_ACCESS_KEY: "test-only-secret-key",
    SES_FROM_EMAIL: "reports@example.com",
    SES_TIMEOUT_MS: "30000",
    SES_MAX_ATTEMPTS: "2",
    NOTIFICATION_LEASE_MS: "300000",
    NOTIFICATION_MAX_ATTEMPTS: "5",
    NOTIFICATION_CONCURRENCY: "2",
    APP_TIME_ZONE: "Asia/Kolkata",
    TIMEZONE_OFFSET_MINUTES: "330",
  });
  assert.equal(validateEnvironment().nodeEnv, "production");
  process.env.EVALUATION_LEASE_MS = "300000";
  assert.throws(() => validateEnvironment(), /EVALUATION_LEASE_MS must be at least/);
  process.env.EVALUATION_LEASE_MS = "600000";
  process.env.NOTIFICATION_LEASE_MS = "60000";
  assert.throws(() => validateEnvironment(), /NOTIFICATION_LEASE_MS must be at least/);
  process.env.NOTIFICATION_LEASE_MS = "300000";
  process.env.PORT = "8000oops";
  assert.throws(() => validateEnvironment(), /PORT must be a whole integer/);
  process.env.PORT = "8000";
  process.env.CORS_ORIGINS = ",,,";
  assert.throws(() => validateEnvironment(), /at least one exact HTTPS origin/);
  process.env.CORS_ORIGINS = "https://facultytrack.example.com";
  process.env.MONGODB_URI = "mongodb://db.example.invalid:27017/grooming_standards";
  assert.throws(() => validateEnvironment(), /must explicitly set tls=true/);
  process.env.MONGODB_URI = "mongodb+srv://db.example.invalid/grooming_standards?tls=false";
  assert.throws(() => validateEnvironment(), /cannot disable TLS/);
  process.env.MONGODB_URI = "mongodb+srv://db.example.invalid/grooming_standards";
  process.env.SECRET_KEY = "replace-with-at-least-32-random-characters";
  assert.throws(() => validateEnvironment(), /SECRET_KEY must be a unique secret/);
  process.env.SECRET_KEY = "x".repeat(64);
  process.env.ADMIN_PASSWORD = "replace-with-a-unique-password-of-at-least-12-characters";
  assert.throws(() => validateEnvironment(), /ADMIN_PASSWORD must be at least 12 characters/);
  process.env.ADMIN_PASSWORD = "test-only-password-123";
  for (const name of [
    "DB_NAME", "GEMINI_MODEL", "GEMINI_TIMEOUT_MS", "GEMINI_MAX_RETRIES",
    "GEMINI_EXPLICIT_CACHE", "GEMINI_CACHE_TTL_SECONDS",
    "EVALUATION_POLL_MS", "EVALUATION_LEASE_MS", "EVALUATION_MAX_ATTEMPTS",
    "EVALUATION_CONCURRENCY", "CHECKIN_CONCURRENCY_LIMIT", "JWT_EXPIRE_MINUTES",
    "JWT_ISSUER", "JWT_AUDIENCE", "SES_TIMEOUT_MS", "SES_MAX_ATTEMPTS",
    "NOTIFICATION_LEASE_MS", "NOTIFICATION_MAX_ATTEMPTS", "NOTIFICATION_CONCURRENCY",
    "APP_TIME_ZONE", "TIMEZONE_OFFSET_MINUTES",
  ]) delete process.env[name];
  const compact = validateEnvironment();
  assert.equal(compact.dbName, "grooming_standards");
  assert.equal(compact.geminiModel, "gemini-2.5-flash-lite");
  assert.equal(compact.geminiExplicitCache, true);
  assert.equal(compact.geminiCacheTtlSeconds, 3600);
  assert.equal(compact.appTimeZone, "Asia/Kolkata");
});

test("Gemini explicit cache configuration validates boolean and TTL overrides", () => {
  process.env.GEMINI_EXPLICIT_CACHE = "false";
  process.env.GEMINI_CACHE_TTL_SECONDS = "7200";
  assert.equal(runtimeConfig().geminiExplicitCache, false);
  assert.equal(runtimeConfig().geminiCacheTtlSeconds, 7200);
  process.env.GEMINI_EXPLICIT_CACHE = "sometimes";
  assert.throws(() => runtimeConfig(), /GEMINI_EXPLICIT_CACHE must be true or false/);
});

test("access tokens carry the configured issuer, audience, and algorithm", () => {
  process.env.SECRET_KEY = "local-test-secret";
  process.env.JWT_ISSUER = "test-issuer";
  process.env.JWT_AUDIENCE = "test-audience";
  const token = createAccessToken({
    sub: "user@example.com",
    role: "SUPER_ADMIN",
    sessionVersion: 7,
  }, 5);
  const decoded = jwt.verify(token, runtimeConfig().jwtSecret, {
    algorithms: ["HS256"],
    issuer: "test-issuer",
    audience: "test-audience",
  });
  assert.equal(decoded.sub, "user@example.com");
  assert.equal(decoded.sv, 7);
  assert.throws(
    () => createAccessToken({ sub: "user@example.com", role: "SUPER_ADMIN", sessionVersion: -1 }),
    /non-negative safe integer/
  );
});

test("image validation checks file signatures instead of trusting MIME headers", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectImageMimeType(jpeg), "image/jpeg");
  assert.deepEqual(validateImageUpload({ buffer: jpeg, mimetype: "image/jpeg" }), {
    valid: true,
    mimeType: "image/jpeg",
  });
  assert.equal(validateImageUpload({ buffer: jpeg, mimetype: "image/png" }).valid, false);
  assert.equal(validateImageUpload({ buffer: Buffer.alloc(12), mimetype: "image/jpeg" }).valid, false);
});

test("image normalization decodes content, bounds size, and strips metadata", async () => {
  const input = await sharp({
    create: {
      width: 640,
      height: 800,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  }).withMetadata({ orientation: 6 }).png().toBuffer();
  const normalized = await normalizeInstructorImage(input);
  const metadata = await sharp(normalized.buffer).metadata();
  assert.equal(normalized.mimeType, "image/jpeg");
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.exif, undefined);
  assert.ok(metadata.width <= 2048 && metadata.height <= 2048);
});

test("coordinates are normalized and constrained to valid ranges", () => {
  assert.equal(parseCoordinates(" 17.45, 78.38 "), "17.45,78.38");
  assert.equal(parseCoordinates("91,0"), null);
  assert.equal(parseCoordinates("not coordinates"), null);
});

test("calendar date bounds are strict and use the configured IANA time zone", () => {
  const india = dateBoundsInTimeZone("2026-08-14", "Asia/Kolkata");
  assert.equal(india.start.toISOString(), "2026-08-13T18:30:00.000Z");
  assert.equal(india.end.toISOString(), "2026-08-14T18:30:00.000Z");

  const dst = dateBoundsInTimeZone("2026-03-08", "America/New_York");
  assert.equal((dst.end.getTime() - dst.start.getTime()) / 3_600_000, 23);
  assert.throws(
    () => dateBoundsInTimeZone("2026-02-30", "Asia/Kolkata"),
    /real calendar date/
  );
  assert.throws(
    () => dateBoundsInTimeZone(["2026-08-14", "2026-08-15"], "Asia/Kolkata"),
    /provided only once/
  );
});

test("pagination accepts only canonical values within configured boundaries", () => {
  const options = { defaultLimit: 25, maxLimit: 100, maxOffset: 1_000_000 };
  assert.deepEqual(parsePagination({}, options), { limit: 25, offset: 0 });
  assert.deepEqual(parsePagination({ limit: "1", offset: "0" }, options), {
    limit: 1,
    offset: 0,
  });
  assert.deepEqual(
    parsePagination({ limit: "100", offset: "1000000" }, options),
    { limit: 100, offset: 1_000_000 }
  );

  for (const query of [
    { limit: "0" },
    { limit: "101" },
    { limit: "01" },
    { limit: "1.5" },
    { limit: ["1", "2"] },
    { offset: "-1" },
    { offset: "1000001" },
    { offset: "01" },
    { offset: ["0", "1"] },
  ]) {
    assert.throws(() => parsePagination(query, options), RangeError);
  }
});

test("technical analysis errors are never described as non-compliance", () => {
  const email = buildCheckoutEmail({ status: "error" });
  assert.match(email.text, /ANALYSIS UNAVAILABLE/);
  assert.doesNotMatch(email.text, /NON-COMPLIANT/);
  const checkinEmail = buildEvaluationEmail({ overallStatus: "error" });
  assert.match(checkinEmail.text, /could not be analysed/);
  assert.doesNotMatch(checkinEmail.text, /has been analysed/);
});

test("AI instructions request concise evidence instead of hidden reasoning", () => {
  const prompt = buildSystemPrompt("MALE", "FORMAL");
  assert.doesNotMatch(prompt, /Chain of Thought/i);
  assert.match(prompt, /image_quality/);
  assert.match(prompt, /checkpoint_name/);
});

test("gender edits accept only male or female, in any casing", () => {
  assert.equal(instructorGenderSchema.parse({ gender: "male" }).gender, "MALE");
  assert.equal(instructorGenderSchema.parse({ gender: " Female " }).gender, "FEMALE");
  // The AI selects reference photos from this value, so anything it cannot map
  // to a rule set has to be refused rather than stored and silently ignored.
  for (const rejected of ["", "OTHER", "M", "unknown", null]) {
    assert.throws(() => instructorGenderSchema.parse({ gender: rejected }));
  }
});

test("every HTTP method the API routes use is allowed through CORS", async () => {
  // A route the browser cannot preflight is invisible from the frontend: the
  // request fails before it reaches Express, so route-level tests still pass
  // while the feature is broken in production. This compares the allowlist
  // against the verbs the routers actually register.
  const routers = await Promise.all([
    import("../src/routes/instructorRoutes.js"),
    import("../src/routes/attendanceRoutes.js"),
    import("../src/routes/authRoutes.js"),
  ]);
  const used = new Set();
  for (const module of routers) {
    for (const router of Object.values(module)) {
      for (const layer of router?.stack || []) {
        for (const method of Object.keys(layer.route?.methods || {})) {
          used.add(method.toUpperCase());
        }
      }
    }
  }
  assert.ok(used.size > 0, "no routes were discovered; the test cannot verify anything");
  for (const method of used) {
    assert.ok(CORS_METHODS.includes(method), `${method} is routed but blocked by CORS`);
  }
});

test("emailed links cannot be built from a localhost origin in production", () => {
  // https://localhost is a legitimate CORS entry — the mobile shell uses it —
  // but as a link it sends the recipient to their own machine, so the report
  // is unreachable and nothing in the system notices.
  const withOrigins = (origins) => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = origins.split(",")[0];
    Object.assign(process.env, {
      PORT: "8000", MONGODB_URI: "mongodb+srv://u:p@h/?appName=x", DB_NAME: "d",
      SECRET_KEY: "x".repeat(48), JWT_EXPIRE_MINUTES: "480",
      JWT_ISSUER: "i", JWT_AUDIENCE: "a",
      ADMIN_EMAIL: "admin@nxtwave.com", ADMIN_PASSWORD: "Faculty@2026!Track",
      ADMIN_PASSWORD_VERSION: "2", AWS_REGION: "ap-south-1",
      AWS_ACCESS_KEY_ID: "p", AWS_SECRET_ACCESS_KEY: "p", SES_FROM_EMAIL: "n@e.com",
      APP_TIME_ZONE: "Asia/Kolkata", TIMEZONE_OFFSET_MINUTES: "330",
      GEMINI_API_KEY: "p", GEMINI_MODEL: "gemini-2.5-flash-lite",
      GEMINI_TIMEOUT_MS: "120000", GEMINI_MAX_RETRIES: "2",
      EVALUATION_POLL_MS: "2000", EVALUATION_LEASE_MS: "600000", EVALUATION_MAX_ATTEMPTS: "3",
      EVALUATION_CONCURRENCY: "2", CHECKIN_CONCURRENCY_LIMIT: "5",
      SES_TIMEOUT_MS: "10000", SES_MAX_ATTEMPTS: "3",
      NOTIFICATION_LEASE_MS: "600000", NOTIFICATION_MAX_ATTEMPTS: "3", NOTIFICATION_CONCURRENCY: "2",
      CRON_SECRET: "cron-secret", R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      R2_BUCKET: "photos", R2_ACCESS_KEY_ID: "r2-key", R2_SECRET_ACCESS_KEY: "r2-secret",
      CORS_ORIGINS: origins,
    });
    try {
      validateEnvironment();
      return null;
    } catch (error) {
      return error.message;
    }
  };

  // The mobile shell's origin alongside the real site is fine: the site wins.
  assert.equal(withOrigins("https://nxtgroom-xi.vercel.app,https://localhost"), null);
  assert.equal(appUrl(), "https://nxtgroom-xi.vercel.app");

  for (const origins of ["http://localhost:5175", "https://localhost", "http://127.0.0.1:8080"]) {
    assert.match(String(withOrigins(origins)), /emailed report links are built from it/,
      `${origins} would email a link nobody outside this machine can open`);
  }
});

const COLLECTION = "audit_logs";
const SKIPPED = [
  /^\/api\/v2\/attendance\/(auto|auto\/group|check-in|check-out)\/?$/,
  /^\/api\/v2\/instructors\/import\/preview\/?$/,
];
const SECRET_FIELDS = /password|token|secret|credential/i;
let indexed = false;

const RESOURCES = [
  [/^\/api\/v2\/settings\/([^/]+)/, (match) => `settings: ${match[1].replace(/-/g, " ")}`],
  [/^\/api\/v2\/instructors\/[^/]+\/face/, () => "instructor reference photo"],
  [/^\/api\/v2\/instructors\/[^/]+\/gender/, () => "instructor gender"],
  [/^\/api\/v2\/instructors\/import/, () => "instructor import"],
  [/^\/api\/v2\/instructors/, () => "instructor"],
  [/^\/api\/v2\/attendance\/bulk-delete/, () => "attendance records (bulk)"],
  [/^\/api\/v2\/attendance\/[^/]+\/reanalyse/, () => "attendance report (re-analyse)"],
  [/^\/api\/v2\/attendance\/[^/]+\/check-out/, () => "attendance check-out"],
  [/^\/api\/v2\/attendance\/[^/]+\/checkout-photo/, () => "attendance check-out photo"],
  [/^\/api\/v2\/attendance/, () => "attendance record"],
  [/^\/api\/v2\/colleges/, () => "institute"],
  [/^\/api\/v2\/admins\/[^/]+\/password/, () => "admin password"],
  [/^\/api\/v2\/admins/, () => "admin user"],
  [/^\/api\/v2\/boas\/[^/]+\/password/, () => "BOA password"],
  [/^\/api\/v2\/boas/, () => "BOA user"],
  [/^\/api\/v2\/users\/[^/]+\/permissions/, () => "user permissions"],
];

const VERBS = { POST: "Created", PUT: "Updated", PATCH: "Updated", DELETE: "Deleted" };

export function describeRequest(method, path) {
  const cleanPath = String(path || "").split("?")[0];
  if (SKIPPED.some((pattern) => pattern.test(cleanPath))) return null;
  for (const [pattern, label] of RESOURCES) {
    const match = cleanPath.match(pattern);
    if (!match) continue;
    const resource = label(match);
    const isSettings = resource.startsWith("settings");
    const verb = isSettings
      ? (method === "DELETE" ? "Removed from" : method === "POST" ? "Added to" : "Changed")
      : /password/.test(resource) ? "Set"
        : /reanalyse/.test(resource) ? "Ran"
          : /reference photo/.test(resource) && method !== "DELETE" ? "Uploaded"
            : VERBS[method] || method;
    const category = isSettings ? "settings"
      : method === "DELETE" || /bulk-delete/.test(cleanPath) ? "delete"
        : method === "POST" && !/password|reanalyse|reference photo|import/.test(resource) ? "create"
          : "edit";
    return { action: `${verb} ${resource}`, category };
  }
  return null;
}

function targetOf(path) {
  const parts = String(path || "").split("?")[0].split("/").filter(Boolean).slice(2);
  const id = parts.find((part, index) => index > 0 && /^[A-Za-z0-9_%@.-]{6,}$/.test(part) && !/^(password|permissions|face|gender|reanalyse|check-out|checkout-photo|recipients|categories|events)$/.test(part));
  return id ? decodeURIComponent(id).slice(0, 120) : null;
}

function fieldsOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body).filter((key) => !SECRET_FIELDS.test(key)).slice(0, 20);
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "").slice(0, 64);
}

export async function recordAudit(db, entry) {
  if (!db) return;
  try {
    const collection = db.collection(COLLECTION);
    if (!indexed && typeof collection.createIndex === "function") {
      indexed = true;
      collection.createIndex({ at: -1 }).catch(() => { indexed = false; });
    }
    await collection.insertOne({ at: new Date(), ...entry });
  } catch (error) {
    console.error(`Audit log write failed (${error?.name || "Error"})`);
  }
}

export function auditRequest(req, { action, category, actor, status, target = null, fields = [] }) {
  return recordAudit(req.app?.locals?.db, {
    actor_email: actor?.email || null,
    actor_role: actor?.role || null,
    action,
    category,
    method: req.method,
    path: String(req.originalUrl || req.url || "").split("?")[0].slice(0, 200),
    target,
    fields,
    status,
    ip: clientIp(req),
  });
}

export function auditTrail(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const path = String(req.originalUrl || req.url || "");
  const described = describeRequest(req.method, path);
  if (!described) return next();
  res.on("finish", () => {
    if (!req.currentUser || res.statusCode === 401) return;
    void auditRequest(req, {
      ...described,
      actor: req.currentUser,
      status: res.statusCode,
      target: targetOf(path),
      fields: fieldsOf(req.body),
    });
  });
  return next();
}

export const AUDIT_CATEGORIES = ["login", "create", "edit", "delete", "settings"];

export function auditQuery({ q = "", category = "", from = "", to = "" } = {}) {
  const filter = {};
  if (AUDIT_CATEGORIES.includes(category)) filter.category = category;
  const range = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) range.$gte = new Date(`${from}T00:00:00.000+05:30`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) range.$lt = new Date(new Date(`${to}T00:00:00.000+05:30`).getTime() + 24 * 60 * 60 * 1000);
  if (Object.keys(range).length) filter.at = range;
  const term = String(q || "").trim().slice(0, 100);
  if (term) {
    const pattern = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    filter.$or = [{ actor_email: pattern }, { action: pattern }, { target: pattern }, { path: pattern }];
  }
  return filter;
}

export async function listAuditLog(db, query = {}, { limit = 50, offset = 0 } = {}) {
  const filter = auditQuery(query);
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  const skip = Math.max(0, Math.min(100_000, Number(offset) || 0));
  const [entries, total] = await Promise.all([
    db.collection(COLLECTION).find(filter).sort({ at: -1 }).skip(skip).limit(size).toArray(),
    db.collection(COLLECTION).countDocuments(filter),
  ]);
  return {
    total,
    entries: entries.map(({ _id, ...entry }) => ({ id: String(_id), ...entry })),
  };
}

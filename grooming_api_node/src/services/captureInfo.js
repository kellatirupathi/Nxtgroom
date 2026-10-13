const MAX_RAW_LENGTH = 1500;
const TOP_FIELDS = ["source", "video", "region", "output", "bytes", "device"];
const STILL_FIELDS = ["outcome", "capabilities", "requested", "raw", "score", "rotation", "error"];
const CAMERA_FIELDS = ["width", "height", "frameRate", "facingMode", "focusMode"];

function clean(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const text = value.trim().slice(0, 160);
    return text || undefined;
  }
  return undefined;
}

function pick(source, fields) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const out = {};
  for (const field of fields) {
    const value = clean(source[field]);
    if (value !== undefined) out[field] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function parseCaptureInfo(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_RAW_LENGTH) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const info = pick(value, TOP_FIELDS);
  if (!info) return null;
  const still = pick(value.still, STILL_FIELDS);
  const camera = pick(value.camera, CAMERA_FIELDS);
  return { ...info, ...(still ? { still } : {}), ...(camera ? { camera } : {}) };
}

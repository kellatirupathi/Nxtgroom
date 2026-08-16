const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function validateImageUpload(file) {
  if (!file?.buffer) return { valid: false, detail: "An image file is required" };
  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    return { valid: false, detail: "Only JPEG, PNG, and WebP images are allowed" };
  }
  const detectedMimeType = detectImageMimeType(file.buffer);
  if (!detectedMimeType || detectedMimeType !== file.mimetype) {
    return { valid: false, detail: "The uploaded file content does not match a supported image format" };
  }
  return { valid: true, mimeType: detectedMimeType };
}

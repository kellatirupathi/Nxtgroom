import sharp from "sharp";

// Raised from 20MP: 48MP and 64MP phone cameras are now common, and the
// browser normally downscales before upload. This only applies when that
// downscaling was skipped or failed, so it must not reject an ordinary photo.
const MAX_INPUT_PIXELS = 80_000_000;
const MIN_DIMENSION = 320;
export const PHOTO_MAX_DIMENSION = 3072;
// Leave headroom below Rekognition's 5 MB byte limit. These are the same bytes
// stored in R2, searched for identity and subsequently read by the evaluator.
export const PHOTO_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

export async function normalizeInstructorImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("The uploaded image is empty");
  }

  const source = sharp(buffer, {
    animated: false,
    failOn: "warning",
    limitInputPixels: MAX_INPUT_PIXELS,
  });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("The uploaded image dimensions could not be read");
  }
  if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
    throw new Error(`The image must be at least ${MIN_DIMENSION}x${MIN_DIMENSION} pixels`);
  }

  // Start at high quality and full retained resolution. Only unusually detailed
  // images need lower quality or a smaller size to fit the recognition limit.
  // Every attempt starts from the source, avoiding accumulated JPEG loss.
  for (let dimension = PHOTO_MAX_DIMENSION; dimension >= MIN_DIMENSION; dimension = Math.floor(dimension * 0.85)) {
    const pixels = source.clone()
      .rotate()
      .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" });
    for (const quality of [95, 90, 85, 80]) {
      const { data, info } = await pixels.clone()
        .jpeg({ quality, chromaSubsampling: "4:4:4", optimiseCoding: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length > 0 && data.length <= PHOTO_MAX_BYTES && info.width && info.height) {
        return { buffer: data, mimeType: "image/jpeg", width: info.width, height: info.height };
      }
    }
  }
  throw new Error("The uploaded image could not be normalized within the photo size limit");
}

/**
 * The longest side a group photograph is kept at.
 *
 * A group spends pixels on several people. Keep 3072 pixels so faces at the
 * back remain usable. Kept as pixels, never re-encoded whole, so this costs
 * memory for the length of one request rather than repeated encoding.
 */
export const GROUP_MAX_DIMENSION = 3072;

/**
 * A group photograph, decoded once and kept as pixels.
 *
 * The single-person path re-encodes the upload because that encoding is what it
 * stores. A group photograph is never stored - only the crops cut from it are -
 * so encoding it whole would be work thrown away, and every crop would then
 * have to decode it again. Returning the pixels lets each person's crop be cut
 * and encoded exactly once.
 *
 * The same checks as normalizeInstructorImage: a damaged file, a vast one, or
 * one too small to contain a person are refused before anything else runs.
 */
export async function normalizeGroupImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("The uploaded image is empty");
  }
  const source = sharp(buffer, {
    animated: false,
    failOn: "warning",
    limitInputPixels: MAX_INPUT_PIXELS,
  });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("The uploaded image dimensions could not be read");
  }
  if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
    throw new Error(`The image must be at least ${MIN_DIMENSION}x${MIN_DIMENSION} pixels`);
  }

  const { data, info } = await source
    .rotate()
    .resize({
      width: GROUP_MAX_DIMENSION,
      height: GROUP_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    // Three bands whatever arrived, so every crop and the detection image are
    // ordinary colour JPEGs.
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!data.length || !info.width || !info.height) {
    throw new Error("The uploaded image could not be normalized");
  }
  return { data, width: info.width, height: info.height, channels: info.channels };
}

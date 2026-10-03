import sharp from "sharp";

const MAX_INPUT_PIXELS = 80_000_000;
const MIN_DIMENSION = 320;
export const PHOTO_MAX_DIMENSION = 3072;
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

export const GROUP_MAX_DIMENSION = 3072;

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
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!data.length || !info.width || !info.height) {
    throw new Error("The uploaded image could not be normalized");
  }
  return { data, width: info.width, height: info.height, channels: info.channels };
}

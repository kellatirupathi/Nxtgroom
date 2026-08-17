import sharp from "sharp";

// Raised from 20MP: 48MP and 64MP phone cameras are now common, and the
// browser normally downscales before upload. This only applies when that
// downscaling was skipped or failed, so it must not reject an ordinary photo.
const MAX_INPUT_PIXELS = 80_000_000;
const MIN_DIMENSION = 320;
const MAX_DIMENSION = 2048;

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

  const { data, info } = await source
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 86, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  if (!data.length || !info.width || !info.height) {
    throw new Error("The uploaded image could not be normalized");
  }
  return {
    buffer: data,
    mimeType: "image/jpeg",
    width: info.width,
    height: info.height,
  };
}

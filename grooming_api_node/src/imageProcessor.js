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
    // The standard encoder, not mozjpeg. Photographs now arrive as
    // full-resolution stills of up to 2048 pixels rather than 1-2 megapixel
    // video frames, and mozjpeg's trellis search took ~960ms of CPU per such
    // photograph - nearly five seconds of waiting at the tablet on a fifth of
    // a CPU. The standard encoder with optimised Huffman tables takes ~160ms
    // and keeps more of the picture (37.7 dB against 35.5 dB PSNR on the same
    // frame); the price is files about twice the size, which storage barely
    // notices and nothing downstream reads by the byte.
    .jpeg({ quality: 86, chromaSubsampling: "4:4:4", optimiseCoding: true })
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

/**
 * The longest side a group photograph is kept at.
 *
 * Larger than a single photograph's 2048 because a group spends its pixels on
 * several people: six people across a frame each get a sixth of its width, and
 * at 2048 the faces of the people at the back were landing below the size face
 * search can match honestly. Kept as pixels, never re-encoded whole, so the
 * extra size costs memory for the length of one request rather than CPU.
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

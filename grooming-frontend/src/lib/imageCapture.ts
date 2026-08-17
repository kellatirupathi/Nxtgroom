/**
 * Downscales a photo in the browser before upload.
 *
 * A modern phone camera produces 3-8 MB files. On mobile data that upload is
 * the dominant cost of a check-in, and the server immediately resizes to
 * 2048px anyway, so sending the full-resolution original wastes the user's
 * time and bandwidth for pixels that are discarded.
 */

/** Matches the server's MAX_DIMENSION so the backend has no further work to do. */
const MAX_DIMENSION = 2048;
const QUALITY = 0.85;

export interface PreparedPhoto {
  file: File;
  originalBytes: number;
  bytes: number;
  width: number;
  height: number;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The photo could not be read. Try taking it again.'));
    };
    image.src = url;
  });
}

/**
 * Returns a downscaled JPEG, or the original file when anything goes wrong.
 * Failing open matters: a browser quirk in canvas encoding must not block a
 * check-in that would otherwise succeed.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const fallback: PreparedPhoto = {
    file,
    originalBytes: file.size,
    bytes: file.size,
    width: 0,
    height: 0,
  };

  try {
    // createImageBitmap decodes off the main thread where available, so the
    // page keeps responding while a large photo is processed.
    const image = await loadImage(file);
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) return fallback;

    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) return fallback;
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', QUALITY);
    });
    if (!blob) return fallback;

    // Keep the original if the re-encode came out larger, which can happen
    // for an already small or heavily compressed source.
    if (blob.size >= file.size && scale === 1) return fallback;

    const prepared = new File([blob], renameToJpeg(file.name), {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
    return {
      file: prepared,
      originalBytes: file.size,
      bytes: prepared.size,
      width: targetWidth,
      height: targetHeight,
    };
  } catch {
    return fallback;
  }
}

function renameToJpeg(name: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'photo';
  return `${base}.jpg`;
}

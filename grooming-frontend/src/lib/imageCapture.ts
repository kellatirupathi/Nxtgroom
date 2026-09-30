/**
 * Downscales a photo in the browser before upload.
 *
 * Preserve detail up to the same resolution the server stores, while keeping
 * the upload within its byte limit.
 */

/** Matches the server's MAX_DIMENSION so the backend has no further work to do. */
import { encodeUploadJpeg, PHOTO_MAX_DIMENSION } from './photoEncoding.ts';

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
    const image = await loadImage(file);
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) return fallback;

    const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(width, height));
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) return fallback;
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await encodeUploadJpeg(canvas);

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

import { MAX_IMAGE_BYTES } from '../imageValidation.ts';

export const PHOTO_MAX_DIMENSION = 3072;
export const PHOTO_JPEG_QUALITY = 0.95;

interface JpegCanvas {
  toBlob(callback: (blob: Blob | null) => void, type: string, quality: number): void;
}

export async function encodeUploadJpeg(canvas: JpegCanvas, quality = PHOTO_JPEG_QUALITY): Promise<Blob> {
  for (const candidate of [quality, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5].filter((value) => value <= quality)) {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Photo encoding failed')), 'image/jpeg', candidate);
    });
    if (blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error('The photo must be 8 MB or smaller.');
}

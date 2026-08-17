export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp']);

/** Returns a user-facing error message, or an empty string when the file is valid. */
export function validatePhoto(selectedFile: File | null | undefined): string {
  if (!selectedFile) return 'Select a photo to continue.';
  if (!ALLOWED_IMAGE_TYPES.has(selectedFile.type)) return 'Use a JPEG, PNG, or WebP photo.';
  if (!selectedFile.size) return 'The selected photo is empty.';
  if (selectedFile.size > MAX_IMAGE_BYTES) return 'The photo must be 8 MB or smaller.';
  return '';
}

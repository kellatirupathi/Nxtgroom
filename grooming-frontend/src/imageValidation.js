export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validatePhoto(selectedFile) {
  if (!selectedFile) return 'Select a photo to continue.';
  if (!ALLOWED_IMAGE_TYPES.has(selectedFile.type)) return 'Use a JPEG, PNG, or WebP photo.';
  if (!selectedFile.size) return 'The selected photo is empty.';
  if (selectedFile.size > MAX_IMAGE_BYTES) return 'The photo must be 8 MB or smaller.';
  return '';
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp']);

export const MAX_SOURCE_BYTES = 60 * 1024 * 1024;

const SOURCE_IMAGE_TYPES = new Set<string>([
  ...ALLOWED_IMAGE_TYPES,
  'image/heic',
  'image/heif',
]);

export function validateSourcePhoto(selectedFile: File | null | undefined): string {
  if (!selectedFile) return 'Select a photo to continue.';
  if (!selectedFile.size) return 'The selected photo is empty.';
  if (selectedFile.type && !SOURCE_IMAGE_TYPES.has(selectedFile.type)) {
    return 'Use a JPEG, PNG, HEIC, or WebP photo.';
  }
  if (selectedFile.size > MAX_SOURCE_BYTES) {
    return 'That photo is unusually large. Try taking it again.';
  }
  return '';
}

export function validatePhoto(selectedFile: File | null | undefined): string {
  if (!selectedFile) return 'Select a photo to continue.';
  if (!ALLOWED_IMAGE_TYPES.has(selectedFile.type)) return 'Use a JPEG, PNG, or WebP photo.';
  if (!selectedFile.size) return 'The selected photo is empty.';
  if (selectedFile.size > MAX_IMAGE_BYTES) return 'The photo must be 8 MB or smaller.';
  return '';
}

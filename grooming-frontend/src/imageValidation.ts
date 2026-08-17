export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Upper bound on what we will even attempt to downscale. Well above any phone
 * camera, and only there to reject something absurd before it is decoded.
 */
export const MAX_SOURCE_BYTES = 60 * 1024 * 1024;

/**
 * Formats accepted straight from a camera roll. HEIC is included because
 * iPhones hand it over by default; the browser re-encodes it to JPEG during
 * downscaling, so the server never sees it.
 */
const SOURCE_IMAGE_TYPES = new Set<string>([
  ...ALLOWED_IMAGE_TYPES,
  'image/heic',
  'image/heif',
]);

/**
 * Checks a file as it comes off the camera, before downscaling.
 *
 * Deliberately lenient about size: a 12MP phone photo is around 11 MB and
 * becomes roughly 400 KB once resized, so rejecting it here would block a
 * photo the system handles perfectly well a moment later.
 */
export function validateSourcePhoto(selectedFile: File | null | undefined): string {
  if (!selectedFile) return 'Select a photo to continue.';
  if (!selectedFile.size) return 'The selected photo is empty.';
  // Some Android pickers report an empty type for camera captures, so an
  // unknown type is allowed through and judged after decoding instead.
  if (selectedFile.type && !SOURCE_IMAGE_TYPES.has(selectedFile.type)) {
    return 'Use a JPEG, PNG, HEIC, or WebP photo.';
  }
  if (selectedFile.size > MAX_SOURCE_BYTES) {
    return 'That photo is unusually large. Try taking it again.';
  }
  return '';
}

/**
 * Checks the file that will actually be uploaded, after downscaling. This is
 * the limit the server enforces, so it must match.
 */
export function validatePhoto(selectedFile: File | null | undefined): string {
  if (!selectedFile) return 'Select a photo to continue.';
  if (!ALLOWED_IMAGE_TYPES.has(selectedFile.type)) return 'Use a JPEG, PNG, or WebP photo.';
  if (!selectedFile.size) return 'The selected photo is empty.';
  if (selectedFile.size > MAX_IMAGE_BYTES) return 'The photo must be 8 MB or smaller.';
  return '';
}

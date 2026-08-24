export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The normalized bounds of the visible full-body guide in the preview. */
export const BODY_GUIDE_BOUNDS = {
  left: 0.13,
  top: 0.02,
  width: 0.74,
  height: 0.96,
} as const;

/**
 * Returns the source rectangle displayed by CSS `object-fit: cover` with the
 * default centred object position.
 *
 * Camera previews commonly have a different aspect ratio from the sensor. If
 * capture saves the whole sensor frame, the saved photo contains space that
 * was never visible inside the guide. Both analysis and capture use this same
 * rectangle so the preview is an honest viewfinder.
 */
export function coverSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): SourceRect {
  if (![sourceWidth, sourceHeight, viewportWidth, viewportHeight].every((value) => (
    Number.isFinite(value) && value > 0
  ))) {
    return { x: 0, y: 0, width: Math.max(0, sourceWidth), height: Math.max(0, sourceHeight) };
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const viewportAspect = viewportWidth / viewportHeight;
  if (sourceAspect > viewportAspect) {
    const width = sourceHeight * viewportAspect;
    return { x: (sourceWidth - width) / 2, y: 0, width, height: sourceHeight };
  }

  const height = sourceWidth / viewportAspect;
  return { x: 0, y: (sourceHeight - height) / 2, width: sourceWidth, height };
}

/**
 * Returns only the sensor pixels shown inside the full-body guide bounds.
 * This composes the guide with the preview's `object-fit: cover` crop, keeping
 * the saved photograph pixel-for-pixel aligned with what the user framed.
 */
export function bodyGuideSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): SourceRect {
  const visible = coverSourceRect(
    sourceWidth,
    sourceHeight,
    viewportWidth,
    viewportHeight,
  );
  return {
    x: visible.x + visible.width * BODY_GUIDE_BOUNDS.left,
    y: visible.y + visible.height * BODY_GUIDE_BOUNDS.top,
    width: visible.width * BODY_GUIDE_BOUNDS.width,
    height: visible.height * BODY_GUIDE_BOUNDS.height,
  };
}

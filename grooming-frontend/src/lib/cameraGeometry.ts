export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BODY_GUIDE_BOUNDS = {
  left: 0,
  top: 0,
  width: 1,
  height: 1,
} as const;

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

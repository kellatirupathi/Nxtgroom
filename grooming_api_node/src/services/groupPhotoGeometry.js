const FACE_BOX_TO_HEAD = 0.78;

const HEADS_PER_BODY = 7.6;

const SHOULDERS_PER_FACE_WIDTH = 3.4;

const BODY_SIDE_MARGIN = 0.12;

const FACE_SEARCH_PADDING = 0.55;

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

export function normalizeBoundingBox(box) {
  const left = clamp(Number(box?.Left ?? box?.left), -1, 2);
  const top = clamp(Number(box?.Top ?? box?.top), -1, 2);
  const width = clamp(Number(box?.Width ?? box?.width), 0, 3);
  const height = clamp(Number(box?.Height ?? box?.height), 0, 3);
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function toPixelRect(ratio, imageWidth, imageHeight) {
  const left = Math.floor(clamp(ratio.left, 0, 1) * imageWidth);
  const top = Math.floor(clamp(ratio.top, 0, 1) * imageHeight);
  const right = Math.ceil(clamp(ratio.left + ratio.width, 0, 1) * imageWidth);
  const bottom = Math.ceil(clamp(ratio.top + ratio.height, 0, 1) * imageHeight);
  const width = Math.max(1, Math.min(imageWidth - left, right - left));
  const height = Math.max(1, Math.min(imageHeight - top, bottom - top));
  return { left, top, width, height };
}

export function faceSearchCrop(box, imageWidth, imageHeight) {
  const face = normalizeBoundingBox(box);
  if (!face || !(imageWidth > 0) || !(imageHeight > 0)) return null;
  const padX = face.width * FACE_SEARCH_PADDING;
  const padY = face.height * FACE_SEARCH_PADDING;
  return toPixelRect({
    left: face.left - padX,
    top: face.top - padY,
    width: face.width + padX * 2,
    height: face.height + padY * 2,
  }, imageWidth, imageHeight);
}

export function personBodyCrop(box, imageWidth, imageHeight) {
  const face = normalizeBoundingBox(box);
  if (!face || !(imageWidth > 0) || !(imageHeight > 0)) return null;

  const headHeight = face.height / FACE_BOX_TO_HEAD;
  const crownTop = face.top - (headHeight - face.height);
  const bodyHeight = headHeight * HEADS_PER_BODY;

  const centreX = face.left + face.width / 2;
  const bodyWidth = face.width * SHOULDERS_PER_FACE_WIDTH * (1 + BODY_SIDE_MARGIN * 2);

  return toPixelRect({
    left: centreX - bodyWidth / 2,
    top: crownTop,
    width: bodyWidth,
    height: bodyHeight,
  }, imageWidth, imageHeight);
}

export function bodyCoverage(box, imageWidth, imageHeight) {
  const face = normalizeBoundingBox(box);
  if (!face || !(imageHeight > 0)) return 0;
  const crop = personBodyCrop(box, imageWidth, imageHeight);
  if (!crop) return 0;
  const wanted = (face.height / FACE_BOX_TO_HEAD) * HEADS_PER_BODY * imageHeight;
  if (!(wanted > 0)) return 0;
  return clamp(crop.height / wanted, 0, 1);
}

export function sortFacesForDisplay(faces) {
  const entries = (faces || [])
    .map((face) => ({ face, box: normalizeBoundingBox(face?.box ?? face?.BoundingBox) }))
    .filter((entry) => entry.box);
  return entries
    .sort((a, b) => {
      const sameRow = Math.min(a.box.top + a.box.height, b.box.top + b.box.height)
        - Math.max(a.box.top, b.box.top) > 0;
      if (!sameRow) return a.box.top - b.box.top;
      return a.box.left - b.box.left;
    })
    .map((entry) => entry.face);
}

export const GROUP_GEOMETRY = Object.freeze({
  FACE_BOX_TO_HEAD,
  HEADS_PER_BODY,
  SHOULDERS_PER_FACE_WIDTH,
  FACE_SEARCH_PADDING,
});

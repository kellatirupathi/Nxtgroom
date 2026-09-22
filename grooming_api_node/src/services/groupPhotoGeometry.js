/**
 * Where each person is, in a photograph that contains several of them.
 *
 * Rekognition reports a face as a box; the grooming checkpoints are about a
 * shirt, a waistband and a pair of shoes. This turns the one into the other,
 * and it is pure arithmetic so the framing can be argued about in a test rather
 * than in front of a tablet.
 *
 * Two crops come out of one face, because the two consumers want opposite
 * things. Identification wants the face and almost nothing else, since every
 * extra pixel is a chance for Rekognition to lock onto the wrong person in a
 * crowded frame. Analysis wants the body and barely needs the face at all.
 *
 * Proportions are the ones life drawing uses: an adult is about seven and a
 * half head-heights tall, and a detected face box covers roughly three quarters
 * of a head. Everything below is that rule of thumb, written down.
 */

/**
 * A detected face box occupies about this much of the whole head, crown to
 * chin. Rekognition's box starts near the hairline, so the forehead and hair
 * sit above it and have to be added back.
 */
const FACE_BOX_TO_HEAD = 0.78;

/** Heads from crown to sole. The classical figure, and close enough for a crop. */
const HEADS_PER_BODY = 7.6;

/**
 * Shoulder span as a multiple of face-box width.
 *
 * Deliberately not generous. In a group people stand shoulder to shoulder, so a
 * wide crop buys a neighbour's shirt rather than more of this person's, and the
 * analysis then describes somebody who is not the subject of the record.
 */
const SHOULDERS_PER_FACE_WIDTH = 3.4;

/** A little air around the body, so a crop does not shave the outline itself. */
const BODY_SIDE_MARGIN = 0.12;

/**
 * Context kept around a face for the identity search.
 *
 * Rekognition matches on the face, but a box cropped exactly to its own edges
 * loses the jaw and hairline that its landmarks are measured against. A little
 * over half a face width on each side restores those without admitting the
 * person standing behind.
 */
const FACE_SEARCH_PADDING = 0.55;

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * Rekognition's ratios, made safe to compute with.
 *
 * A face at the edge of the frame is reported with a negative Left, or a Width
 * that runs past 1, because the box describes the whole face including the part
 * that was not photographed. Left unclamped that arithmetic produces a crop
 * rectangle outside the image, which sharp rejects with an error naming neither
 * the face nor the person.
 */
export function normalizeBoundingBox(box) {
  const left = clamp(Number(box?.Left ?? box?.left), -1, 2);
  const top = clamp(Number(box?.Top ?? box?.top), -1, 2);
  const width = clamp(Number(box?.Width ?? box?.width), 0, 3);
  const height = clamp(Number(box?.Height ?? box?.height), 0, 3);
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * Turns a ratio rectangle into whole pixels inside the image.
 *
 * Rounded outwards rather than to nearest, so a rectangle never loses its last
 * row to rounding, and floored to at least one pixel in each direction because
 * an extract of zero width is an error rather than an empty image.
 */
function toPixelRect(ratio, imageWidth, imageHeight) {
  const left = Math.floor(clamp(ratio.left, 0, 1) * imageWidth);
  const top = Math.floor(clamp(ratio.top, 0, 1) * imageHeight);
  const right = Math.ceil(clamp(ratio.left + ratio.width, 0, 1) * imageWidth);
  const bottom = Math.ceil(clamp(ratio.top + ratio.height, 0, 1) * imageHeight);
  const width = Math.max(1, Math.min(imageWidth - left, right - left));
  const height = Math.max(1, Math.min(imageHeight - top, bottom - top));
  return { left, top, width, height };
}

/**
 * The crop sent to Rekognition to ask who this is.
 *
 * Tight on purpose. `SearchFacesByImage` searches the largest face it can find
 * and ignores every other one, which is the whole reason a group photograph
 * cannot be identified in a single call — so each face is cut out and asked
 * about on its own, and the crop has to be tight enough that the intended face
 * is unambiguously the largest one in it.
 */
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

/**
 * The crop analysed for grooming: this person, head to feet.
 *
 * The rectangle is what the proportions ask for, then clipped to the image. A
 * person photographed from the knees up yields a crop that stops at the knees,
 * and the report says footwear was not visible — which is true, and better than
 * a crop padded out with somebody else's legs.
 *
 * Neighbours will still intrude at the edges when people stand close. That is a
 * property of the photograph rather than of the arithmetic, and it is the
 * reason the width here is conservative.
 */
export function personBodyCrop(box, imageWidth, imageHeight) {
  const face = normalizeBoundingBox(box);
  if (!face || !(imageWidth > 0) || !(imageHeight > 0)) return null;

  const headHeight = face.height / FACE_BOX_TO_HEAD;
  // The crown sits above the box by whatever part of the head the box missed.
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

/**
 * How much of the person the crop actually caught, as a fraction.
 *
 * A crop clipped by the bottom of the frame is not a failure — it is a record
 * of somebody photographed from the waist up — but it does decide what the
 * report can honestly say. Kept alongside the record so a thin report has a
 * stated reason rather than looking like the analysis went wrong.
 */
export function bodyCoverage(box, imageWidth, imageHeight) {
  const face = normalizeBoundingBox(box);
  if (!face || !(imageHeight > 0)) return 0;
  const crop = personBodyCrop(box, imageWidth, imageHeight);
  if (!crop) return 0;
  const wanted = (face.height / FACE_BOX_TO_HEAD) * HEADS_PER_BODY * imageHeight;
  if (!(wanted > 0)) return 0;
  return clamp(crop.height / wanted, 0, 1);
}

/**
 * Reading order, so the tablet lists people the way somebody looking at them
 * would: left to right, and top row before bottom when two rows stand behind
 * each other.
 *
 * Rows are decided by overlap rather than by a fixed band, because people are
 * not the same height and a row is only a row if the faces actually sit
 * alongside each other.
 */
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

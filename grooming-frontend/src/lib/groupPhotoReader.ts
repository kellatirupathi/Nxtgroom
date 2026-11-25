// Reads a group photo in the submitter's browser, with no face recognition and
// no work on the server:
//   1. finds each person's face (MediaPipe face detector, ~1 MB, on the GPU),
//      looking at the photo whole and in overlapping tiles so small faces in a
//      group are found too;
//   2. reads the printed text (Tesseract.js, in a web worker), once in black
//      and white and once in grey, which together read light-on-dark labels;
//   3. turns the text into labels and matches each label's employee id (or
//      name) against the institute's instructors (lib/groupLabels.ts);
//   4. gives each person the label nearest to them side to side, and cuts
//      them out head to feet.
// The models are served from this site (public/models) and loaded on first
// use only; later photos reuse them.
import type { FaceDetector } from '@tensorflow-models/face-detection';
import type { Worker as OcrWorker } from 'tesseract.js';
import { assignLabels, mergeWords, readLabels, usableLabel, type Box, type OcrWord, type ReadLabel, type RosterEntry } from './groupLabels';
import { openAnyPhoto } from './instituteForm';
import { bodyCropFromFace, dropBodyPartFaces, dropTinyFaces, mergeFaces, planTiles, sortLeftToRight, uprightFace, WHOLE_PHOTO, type FaceSpot } from './personCrop';

const FACE_MODEL_PATH = '/models/mediapipe-face-detection-full/model.json';
const TESSERACT_PATH = '/models/tesseract-7.0.0';
const DETECTION_MAX_SIDE = 2048;
const READING_MAX_SIDE = 2600;
const CROP_MAX_SIDE = 600;
const MIN_FACE_PIXELS = 12;
const BLACK_WHITE_THRESHOLD = 150;

export interface FoundPerson {
  box: Box;
  crop: Blob;
  label: ReadLabel | null;
}

export interface GroupReading {
  people: FoundPerson[];
  // Every name label read in the photo (for the names offered first).
  labels: ReadLabel[];
  // The labels could not be read on this device at all.
  labelsFailed: boolean;
}

export type ReadingStage = 'loading' | 'people' | 'labels';

let detectorPromise: Promise<FaceDetector> | null = null;
let ocrPromise: Promise<OcrWorker> | null = null;

function faceDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const [faceDetection] = await Promise.all([
        import('@tensorflow-models/face-detection'),
        import('@tensorflow/tfjs-backend-webgl'),
      ]);
      const tf = await import('@tensorflow/tfjs-core');
      try {
        await tf.setBackend('webgl');
      } catch {
        await tf.setBackend('cpu');
      }
      await tf.ready();
      return faceDetection.createDetector(faceDetection.SupportedModels.MediaPipeFaceDetector, {
        runtime: 'tfjs',
        modelType: 'full',
        maxFaces: 40,
        detectorModelUrl: new URL(FACE_MODEL_PATH, window.location.origin).href,
      });
    })();
    detectorPromise.catch(() => { detectorPromise = null; });
  }
  return detectorPromise;
}

function ocrWorker(): Promise<OcrWorker> {
  if (!ocrPromise) {
    ocrPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const base = new URL(TESSERACT_PATH, window.location.origin).href;
      const worker = await createWorker('eng', 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: `${base}/core`,
        langPath: `${base}/lang`,
        workerBlobURL: false,
        gzip: true,
      });
      await worker.setParameters({ tessedit_pageseg_mode: '3' as never });
      return worker;
    })();
    ocrPromise.catch(() => { ocrPromise = null; });
  }
  return ocrPromise;
}

// Frees the reader's memory when the form is left.
export async function releaseGroupPhotoReader(): Promise<void> {
  const pending = ocrPromise;
  ocrPromise = null;
  if (pending) {
    try {
      await (await pending).terminate();
    } catch { }
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

async function findFaces(bitmap: ImageBitmap): Promise<FaceSpot[]> {
  const detector = await faceDetector();
  const scale = Math.min(1, DETECTION_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const work = canvasOf(width, height);
  work.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
  const faces: FaceSpot[] = [];
  for (const tile of planTiles(width, height)) {
    const piece = canvasOf(tile.width, tile.height);
    piece.getContext('2d')?.drawImage(work, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
    const found = await detector.estimateFaces(piece);
    release(piece);
    for (const face of found) {
      if (face.box.width < MIN_FACE_PIXELS) continue;
      if (!uprightFace(face.keypoints, face.box)) continue;
      faces.push({
        left: (tile.x + face.box.xMin) / width,
        top: (tile.y + face.box.yMin) / height,
        width: face.box.width / width,
        height: face.box.height / height,
        score: (face as { score?: number }).score ?? 1,
      });
    }
  }
  release(work);
  return sortLeftToRight(dropTinyFaces(dropBodyPartFaces(mergeFaces(faces))));
}

// The photo enlarged for reading, in grey and in black and white.
function readingImages(bitmap: ImageBitmap): { images: HTMLCanvasElement[]; width: number; height: number } {
  const scale = Math.max(1, Math.min(3, READING_MAX_SIDE / Math.max(bitmap.width, bitmap.height)));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const grey = canvasOf(width, height);
  const greyContext = grey.getContext('2d', { willReadFrequently: true });
  if (!greyContext) return { images: [], width, height };
  greyContext.drawImage(bitmap, 0, 0, width, height);
  const pixels = greyContext.getImageData(0, 0, width, height);
  const blackWhite = new ImageData(width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const value = Math.round(pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114);
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
    const binary = value > BLACK_WHITE_THRESHOLD ? 255 : 0;
    blackWhite.data[index] = binary;
    blackWhite.data[index + 1] = binary;
    blackWhite.data[index + 2] = binary;
    blackWhite.data[index + 3] = 255;
  }
  greyContext.putImageData(pixels, 0, 0);
  const binaryCanvas = canvasOf(width, height);
  binaryCanvas.getContext('2d')?.putImageData(blackWhite, 0, 0);
  return { images: [binaryCanvas, grey], width, height };
}

async function readWords(bitmap: ImageBitmap): Promise<OcrWord[]> {
  const worker = await ocrWorker();
  const { images, width, height } = readingImages(bitmap);
  const words: OcrWord[] = [];
  try {
    for (const image of images) {
      const { data } = await worker.recognize(image, {}, { blocks: true });
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            for (const word of line.words) {
              const text = word.text.trim();
              if (!text) continue;
              words.push({
                text,
                confidence: word.confidence,
                box: {
                  left: word.bbox.x0 / width,
                  top: word.bbox.y0 / height,
                  width: (word.bbox.x1 - word.bbox.x0) / width,
                  height: (word.bbox.y1 - word.bbox.y0) / height,
                },
              });
            }
          }
        }
      }
    }
  } finally {
    images.forEach(release);
  }
  return mergeWords(words);
}

// One part of the photo as a small JPEG (fractions of the photo).
async function cropBitmap(bitmap: ImageBitmap, box: Box): Promise<Blob> {
  const sx = Math.max(0, Math.round(box.left * bitmap.width));
  const sy = Math.max(0, Math.round(box.top * bitmap.height));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(box.width * bitmap.width)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(box.height * bitmap.height)));
  const scale = Math.min(1, CROP_MAX_SIDE / Math.max(sw, sh));
  const canvas = canvasOf(sw * scale, sh * scale);
  canvas.getContext('2d')?.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  release(canvas);
  if (!blob) throw new Error('The picture could not be cut out.');
  return blob;
}

// The full-size original when this browser can open it, or else the photo as
// it will be sent.
async function openPhoto(file: Blob, fallback?: Blob): Promise<ImageBitmap> {
  try {
    return await openAnyPhoto(file);
  } catch (error) {
    if (!fallback || fallback === file) throw error;
    return openAnyPhoto(fallback);
  }
}

// Everyone in a group photo (or a photo of one person), left to right, each
// cut out and (when a label next to them could be read and matched) named.
export async function readGroupPhoto(
  file: Blob,
  fallback: Blob | undefined,
  roster: readonly RosterEntry[],
  onStage: (stage: ReadingStage) => void = () => { },
): Promise<GroupReading> {
  onStage('loading');
  const bitmap = await openPhoto(file, fallback);
  try {
    onStage('people');
    let faces: FaceSpot[] = [];
    try {
      faces = await findFaces(bitmap);
    } catch (error) {
      // Without the face finder the photo is still taken as one person.
      console.warn('Faces could not be found', error);
    }
    onStage('labels');
    let labels: ReadLabel[] = [];
    let labelsFailed = false;
    try {
      labels = readLabels(await readWords(bitmap), roster, bitmap.width / bitmap.height);
    } catch (error) {
      // Without the labels everyone is still cut out, to be named by hand.
      console.warn('Name labels could not be read', error);
      labels = [];
      labelsFailed = true;
    }
    // No face found: the whole photo is one person (a photo of one person),
    // named by an instructor label or id anywhere in it, or by hand.
    const boxes = faces.length ? faces.map((face) => bodyCropFromFace(face)) : [WHOLE_PHOTO];
    const spots = faces.length
      ? faces.map((face, index) => ({
        centerX: face.left + face.width / 2,
        width: boxes[index].width,
        faceTop: face.top,
        faceHeight: face.height,
      }))
      : [{ centerX: 0.5, width: 1 }];
    const assigned = assignLabels(spots, labels);
    const people: FoundPerson[] = [];
    for (const [index, box] of boxes.entries()) {
      people.push({ box, crop: await cropBitmap(bitmap, box), label: assigned[index] });
    }
    // Names alone count as labels only where they named someone (other words
    // in the photo are not labels).
    const named = labels.filter((label) => usableLabel(label) || assigned.includes(label));
    return { people, labels: named, labelsFailed };
  } finally {
    bitmap.close();
  }
}

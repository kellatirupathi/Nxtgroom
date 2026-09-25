/**
 * Takes the attendance photograph at the camera's full still resolution.
 *
 * Until now the photograph was a frame grabbed from the live video, which on a
 * tablet is one to two megapixels - and much of that is spent on the room,
 * because the whole body has to fit. A face came out 40 to 90 pixels tall, and
 * below about 60 face search stops being sure enough to name anybody. The same
 * camera takes still photographs at eight to twelve megapixels.
 *
 * So the photograph is now a still where the browser can take one (Chrome and
 * the Android app shell can; Safari and Firefox cannot), and the video frame
 * otherwise. A still is only used once it is proven to show what the camera
 * approved - see stillRegistration - and every failure along the way falls
 * back to the video frame, taken at the moment the camera decided to fire.
 * The worst a still can do is cost a second; it can never change what is
 * photographed.
 *
 * Both are unmirrored. The preview is mirrored for the front camera because an
 * unmirrored self-view is disorienting, but the saved photograph must not be:
 * a mirrored image reverses the text on a lanyard or badge.
 */

import type { SourceRect } from './cameraGeometry.ts';
import {
  candidateRotations,
  chooseMapping,
  drawTransform,
  fitWithin,
  mapRegion,
  orientedSize,
  referenceGridSize,
  regionFits,
  registerStill,
  thumbnailScale,
  worthUsing,
  type GrayImage,
  type Rect,
  type Rotation,
  type Size,
} from './stillRegistration.ts';

/** The longest side the upload may have; the server keeps no more. */
export const SINGLE_UPLOAD_MAX_DIMENSION = 2048;
/** Matches the server's GROUP_MAX_DIMENSION: a group spends pixels on several people. */
export const GROUP_UPLOAD_MAX_DIMENSION = 3072;

/**
 * The largest still asked for. Twelve megapixels is several times what either
 * upload keeps, and a 48-megapixel still decoded on a tablet is 190MB of
 * memory for nothing.
 */
export const MAX_STILL_LONG_SIDE = 4032;
/** A still slower than this is abandoned for the video frame. */
export const STILL_TIMEOUT_MS = 3000;
/** Errors in a row before stills are given up on for this camera. */
export const MAX_STILL_FAILURES = 2;
/**
 * Stills in a row that could not be matched before they are given up on. More
 * than the error limit, because one person moving as the shutter went is not
 * a fault; the same miss four times over is a device whose stills do not line
 * up, and every attempt is a second of waiting for nothing.
 */
export const MAX_STILL_MISSES = 4;

interface PhotoSettingsLike {
  imageWidth?: number;
  imageHeight?: number;
}

interface PhotoCapabilitiesLike {
  imageWidth?: { max?: number };
  imageHeight?: { max?: number };
}

interface ImageCaptureLike {
  takePhoto(settings?: PhotoSettingsLike): Promise<Blob>;
  getPhotoCapabilities?(): Promise<PhotoCapabilitiesLike>;
}

type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike;

interface BitmapLike {
  width: number;
  height: number;
  close?: () => void;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d', options?: { willReadFrequently?: boolean }): Context2DLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

interface Context2DLike {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(...args: unknown[]): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
}

/** What the capture needs from the browser, injectable so it can be tested. */
export interface CaptureEnvironment {
  createCanvas: () => CanvasLike;
  createImageBitmap: (blob: Blob) => Promise<BitmapLike>;
  ImageCapture: ImageCaptureConstructor | null;
  timeoutMs?: number;
}

function browserEnvironment(): CaptureEnvironment {
  const scope = globalThis as unknown as {
    ImageCapture?: ImageCaptureConstructor;
    createImageBitmap?: (blob: Blob) => Promise<BitmapLike>;
  };
  return {
    createCanvas: () => document.createElement('canvas') as unknown as CanvasLike,
    createImageBitmap: (blob) => {
      if (typeof scope.createImageBitmap !== 'function') return Promise.reject(new Error('no createImageBitmap'));
      return scope.createImageBitmap(blob);
    },
    ImageCapture: typeof scope.ImageCapture === 'function' ? scope.ImageCapture : null,
  };
}

/** Per camera, kept by the component across photographs. */
export interface StillCaptureState {
  trackId: string | null;
  camera: ImageCaptureLike | null;
  /** undefined: not asked yet. null: let the browser choose. */
  settings: PhotoSettingsLike | null | undefined;
  failures: number;
  misses: number;
  disabled: boolean;
  /** How the last photograph was taken. */
  lastSource: 'still' | 'video' | null;
}

export function createStillCaptureState(): StillCaptureState {
  return {
    trackId: null,
    camera: null,
    settings: undefined,
    failures: 0,
    misses: 0,
    disabled: false,
    lastSource: null,
  };
}

export type StillOutcome = 'used' | 'miss' | 'failure';

/**
 * Updates the running record after one still.
 *
 * Success clears both counts. A miss clears the error count (the camera works)
 * and adds a miss; an error adds an error. Either limit reached, stills are
 * off until the camera is next opened - a new track starts a new record.
 */
export function recordStillOutcome(state: StillCaptureState, outcome: StillOutcome): void {
  if (outcome === 'used') {
    state.failures = 0;
    state.misses = 0;
    return;
  }
  if (outcome === 'miss') {
    state.failures = 0;
    state.misses += 1;
  } else {
    state.failures += 1;
  }
  if (state.failures >= MAX_STILL_FAILURES || state.misses >= MAX_STILL_MISSES) state.disabled = true;
}

/**
 * The still size to ask for, or that stills are pointless on this camera.
 *
 * A still no bigger than the video - a desktop webcam, typically - costs the
 * wait and buys nothing, so such a camera never takes one. Otherwise the
 * largest still is asked for, capped at MAX_STILL_LONG_SIDE; the browser picks
 * the nearest size the camera actually offers.
 */
export function decidePhotoSettings(
  capabilities: PhotoCapabilitiesLike | null | undefined,
  video: Size,
): { usable: boolean; settings: PhotoSettingsLike | null } {
  const maxWidth = Number(capabilities?.imageWidth?.max) || 0;
  const maxHeight = Number(capabilities?.imageHeight?.max) || 0;
  if (!maxWidth || !maxHeight) return { usable: true, settings: null };
  if (maxWidth * maxHeight < 1.5 * video.width * video.height) return { usable: false, settings: null };
  const factor = Math.min(1, MAX_STILL_LONG_SIDE / Math.max(maxWidth, maxHeight));
  return {
    usable: true,
    settings: { imageWidth: Math.round(maxWidth * factor), imageHeight: Math.round(maxHeight * factor) },
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function canvas2d(env: CaptureEnvironment, size: Size, readable = false) {
  const canvas = env.createCanvas();
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', readable ? { willReadFrequently: true } : undefined);
  if (!context) throw new Error('no 2d context');
  // High quality, because every draw here shrinks: a thumbnail drawn with the
  // default filter aliases, and an aliased thumbnail aligns badly.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return { canvas, context };
}

function toGray(context: Context2DLike, size: Size): GrayImage {
  const { data } = context.getImageData(0, 0, size.width, size.height);
  const gray = new Float32Array(size.width * size.height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  }
  return { data: gray, width: size.width, height: size.height };
}

function encode(canvas: CanvasLike, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/jpeg', quality);
  });
}

/** Trims a region that overhangs the still by rounding, so no edge is left blank. */
function clampRegion(region: Rect, size: Size): Rect {
  const x = Math.max(0, region.x);
  const y = Math.max(0, region.y);
  return {
    x,
    y,
    width: Math.min(size.width, region.x + region.width) - x,
    height: Math.min(size.height, region.y + region.height) - y,
  };
}

export interface CapturedPhoto {
  blob: Blob;
  source: 'still' | 'video';
  width: number;
  height: number;
}

export interface CaptureOptions {
  video: HTMLVideoElement | { videoWidth: number; videoHeight: number };
  track: Pick<MediaStreamTrack, 'id' | 'readyState'> | null;
  /** The part of the video frame to keep, in video pixels. */
  region: SourceRect;
  maxDimension: number;
  quality: number;
  state: StillCaptureState;
}

interface StillAttempt {
  env: CaptureEnvironment;
  track: Pick<MediaStreamTrack, 'id' | 'readyState'>;
  region: SourceRect;
  videoSize: Size;
  reference: GrayImage;
  maxDimension: number;
  quality: number;
  state: StillCaptureState;
}

async function takeStill({
  env,
  track,
  region,
  videoSize,
  reference,
  maxDimension,
  quality,
  state,
}: StillAttempt): Promise<CapturedPhoto | null> {
  const ImageCapture = env.ImageCapture;
  if (!ImageCapture) {
    state.disabled = true;
    return null;
  }
  let bitmap: BitmapLike | null = null;
  try {
    // One ImageCapture per camera track. A restarted or flipped camera is a
    // new track, and starts a new record of what its stills can do.
    if (state.trackId !== track.id || !state.camera) {
      state.trackId = track.id;
      state.camera = new ImageCapture(track as MediaStreamTrack);
      state.settings = undefined;
      state.failures = 0;
      state.misses = 0;
    }
    const camera = state.camera;
    if (state.settings === undefined) {
      let capabilities: PhotoCapabilitiesLike | null = null;
      if (typeof camera.getPhotoCapabilities === 'function') {
        capabilities = await withTimeout(camera.getPhotoCapabilities(), 2000).catch(() => null);
      }
      const decision = decidePhotoSettings(capabilities, videoSize);
      if (!decision.usable) {
        state.disabled = true;
        return null;
      }
      state.settings = decision.settings;
    }

    const blob = await withTimeout(
      camera.takePhoto(state.settings ?? undefined),
      env.timeoutMs ?? STILL_TIMEOUT_MS,
    );
    bitmap = await env.createImageBitmap(blob);
    const raw = { width: bitmap.width, height: bitmap.height };
    const source = bitmap;

    // Each way up the still might have been handed over, aligned in turn.
    const candidates = candidateRotations(raw, videoSize).map((rotation: Rotation) => {
      const oriented = orientedSize(raw, rotation);
      const scale = thumbnailScale(oriented, videoSize, region);
      const thumbSize = {
        width: Math.max(8, Math.round(oriented.width * scale)),
        height: Math.max(8, Math.round(oriented.height * scale)),
      };
      const thumb = canvas2d(env, thumbSize, true);
      thumb.context.setTransform(...drawTransform(raw, rotation, { x: 0, y: 0, ...oriented }, thumbSize));
      thumb.context.drawImage(source, 0, 0);
      const mapping = registerStill({
        region,
        reference,
        video: videoSize,
        still: toGray(thumb.context, thumbSize),
        stillSize: oriented,
      });
      return { rotation, oriented, mapping };
    });

    const chosen = chooseMapping(candidates);
    const oriented = chosen ? candidates.find((candidate) => candidate.rotation === chosen.rotation)?.oriented : null;
    const stillRegion = chosen ? mapRegion(region, chosen.mapping) : null;
    if (
      !chosen
      || !oriented
      || !stillRegion
      || !regionFits(stillRegion, oriented)
      || !worthUsing(stillRegion, region, maxDimension)
    ) {
      recordStillOutcome(state, 'miss');
      return null;
    }

    const drawn = clampRegion(stillRegion, oriented);
    const outputSize = fitWithin(drawn, maxDimension);
    const output = canvas2d(env, outputSize);
    output.context.setTransform(...drawTransform(raw, chosen.rotation, drawn, outputSize));
    output.context.drawImage(source, 0, 0);
    const photo = await encode(output.canvas, quality);
    recordStillOutcome(state, 'used');
    return { blob: photo, source: 'still', width: outputSize.width, height: outputSize.height };
  } catch {
    recordStillOutcome(state, 'failure');
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/**
 * The photograph for one capture.
 *
 * The video frame is taken first and at once - it is the moment the camera
 * approved, it is the reference a still is checked against, and it is the
 * photograph whenever a still cannot be used. Only then is a still attempted.
 */
export async function capturePhoto(
  { video, track, region, maxDimension, quality, state }: CaptureOptions,
  env: CaptureEnvironment = browserEnvironment(),
): Promise<CapturedPhoto> {
  const videoSize = { width: video.videoWidth, height: video.videoHeight };

  // A different camera track - reopened after the screen slept, after a tab
  // switch, or flipped front to back - starts a clean record. Whatever made
  // stills unusable on the last camera may not be true of this one.
  if (track && state.trackId !== null && state.trackId !== track.id) {
    Object.assign(state, createStillCaptureState());
  }

  const frameSize = fitWithin(region, maxDimension);
  const frame = canvas2d(env, frameSize);
  frame.context.drawImage(
    video,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    frameSize.width,
    frameSize.height,
  );

  const stillsPossible = !state.disabled && Boolean(env.ImageCapture) && track?.readyState === 'live';
  if (stillsPossible && track) {
    const grid = referenceGridSize(region);
    const small = canvas2d(env, grid, true);
    small.context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, grid.width, grid.height);
    const reference = toGray(small.context, grid);

    const still = await takeStill({
      env,
      track,
      region,
      videoSize,
      reference,
      maxDimension,
      quality,
      state,
    });
    if (still) {
      state.lastSource = 'still';
      return still;
    }
  }

  state.lastSource = 'video';
  const blob = await encode(frame.canvas, quality);
  return { blob, source: 'video', width: frameSize.width, height: frameSize.height };
}

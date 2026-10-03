import type { SourceRect } from './cameraGeometry.ts';
import { encodeUploadJpeg, PHOTO_MAX_DIMENSION } from './photoEncoding.ts';
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

export const SINGLE_UPLOAD_MAX_DIMENSION = PHOTO_MAX_DIMENSION;
export const GROUP_UPLOAD_MAX_DIMENSION = 3072;

export const MAX_STILL_LONG_SIDE = 4032;
export const STILL_TIMEOUT_MS = 3000;
export const MAX_STILL_FAILURES = 2;
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

export interface StillCaptureState {
  trackId: string | null;
  camera: ImageCaptureLike | null;
  settings: PhotoSettingsLike | null | undefined;
  failures: number;
  misses: number;
  disabled: boolean;
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
  return encodeUploadJpeg(canvas, quality);
}

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

export async function capturePhoto(
  { video, track, region, maxDimension, quality, state }: CaptureOptions,
  env: CaptureEnvironment = browserEnvironment(),
): Promise<CapturedPhoto> {
  const videoSize = { width: video.videoWidth, height: video.videoHeight };

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

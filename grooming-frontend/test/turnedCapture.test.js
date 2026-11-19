import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capturePhoto, createStillCaptureState, GROUP_UPLOAD_MAX_DIMENSION } from '../src/lib/stillCapture.ts';
import { describeCapture } from '../src/lib/captureInfo.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function recordingEnv() {
  const canvases = [];
  const calls = { takePhoto: 0 };
  return {
    canvases,
    calls,
    env: {
      createCanvas() {
        const canvas = {
          width: 0,
          height: 0,
          ops: [],
          getContext() {
            return {
              imageSmoothingEnabled: false,
              imageSmoothingQuality: 'low',
              setTransform: (...matrix) => canvas.ops.push(['setTransform', ...matrix]),
              drawImage: (_source, ...args) => canvas.ops.push(['drawImage', ...args]),
              getImageData: () => ({ data: new Uint8ClampedArray(4) }),
            };
          },
          toBlob(callback, type) { callback(new Blob(['jpeg'], { type })); },
        };
        canvases.push(canvas);
        return canvas;
      },
      createImageBitmap: async () => ({ width: 4000, height: 3000 }),
      ImageCapture: class {
        takePhoto() { calls.takePhoto += 1; return Promise.resolve(new Blob(['still'])); }
      },
    },
  };
}

// The iPad on 19 November: the screen stayed portrait while the tablet was
// held landscape, so the 960x1280 frame showed the group lying on its side.
const IPAD_VIDEO = { videoWidth: 960, videoHeight: 1280 };
const PORTRAIT_SCREEN = { x: 0, y: 43, width: 960, height: 1193 };

test('a sideways frame is photographed whole and turned upright', async () => {
  const browser = recordingEnv();
  const photo = await capturePhoto({
    video: IPAD_VIDEO,
    track: { id: 'ipad', readyState: 'live' },
    region: PORTRAIT_SCREEN,
    maxDimension: GROUP_UPLOAD_MAX_DIMENSION,
    quality: 0.9,
    state: createStillCaptureState(),
    turn: 90,
  }, browser.env);

  assert.equal(photo.width, 1193, 'the whole visible frame, now landscape');
  assert.equal(photo.height, 960);
  assert.equal(browser.calls.takePhoto, 0, 'a still from a sideways camera would be sideways again');
  const [frame] = browser.canvases;
  assert.deepEqual(frame.ops, [
    ['setTransform', 0, 1, -1, 0, 1193, 0],
    ['drawImage', 0, 43, 960, 1193, 0, 0, 960, 1193],
    ['setTransform', 1, 0, 0, 1, 0, 0],
  ]);
  assert.equal(photo.diagnostics.turn, 90);
  assert.equal(photo.diagnostics.still.outcome, 'turned');
  assert.equal(photo.diagnostics.output, '1193x960');
  assert.equal(describeCapture(photo, null, 'test').turn, 90, 'the server is told the photo was turned');
});

test('an upright frame is photographed exactly as before', async () => {
  const browser = recordingEnv();
  browser.env.ImageCapture = null;
  const photo = await capturePhoto({
    video: IPAD_VIDEO,
    track: { id: 'ipad', readyState: 'live' },
    region: PORTRAIT_SCREEN,
    maxDimension: GROUP_UPLOAD_MAX_DIMENSION,
    quality: 0.9,
    state: createStillCaptureState(),
    turn: 0,
  }, browser.env);
  assert.equal(photo.width, 960);
  assert.equal(photo.height, 1193);
  assert.deepEqual(browser.canvases[0].ops, [['drawImage', 0, 43, 960, 1193, 0, 0, 960, 1193]]);
  assert.equal('turn' in photo.diagnostics, false);
  assert.equal('turn' in describeCapture(photo, null, 'test'), false);
});

test('a very large sideways region is still capped at the upload size', async () => {
  const browser = recordingEnv();
  const photo = await capturePhoto({
    video: { videoWidth: 3024, videoHeight: 4032 },
    track: null,
    region: { x: 0, y: 0, width: 3024, height: 4032 },
    maxDimension: 3072,
    quality: 0.9,
    state: createStillCaptureState(),
    turn: 270,
  }, browser.env);
  assert.equal(photo.width, 3072);
  assert.equal(photo.height, 2304);
});

test('both cameras analyse and photograph at the turn the frames need', () => {
  for (const path of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    const camera = read(path);
    assert.match(camera, /readWithTurn\(tracker, read\)/, `${path} does not look for a sideways camera`);
    assert.match(camera, /turn: turnRef\.current,/, `${path} photographs without the turn`);
    assert.match(camera, /mirrored: facing === 'user', turn \}/, `${path} analyses without the turn`);
    assert.match(camera, /setTurn\(tracker, 0\)/, `${path} keeps an old turn after the screen rotates`);
  }
});

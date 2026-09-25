import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  capturePhoto,
  createStillCaptureState,
  decidePhotoSettings,
  GROUP_UPLOAD_MAX_DIMENSION,
  MAX_STILL_FAILURES,
  MAX_STILL_MISSES,
  recordStillOutcome,
  SINGLE_UPLOAD_MAX_DIMENSION,
} from '../src/lib/stillCapture.ts';
import { applyTransform, drawTransform, expectedScale, orientedSize } from '../src/lib/stillRegistration.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * The capture, end to end, against a simulated camera.
 *
 * A fake canvas renders a synthetic scene through whatever the capture draws -
 * the video, or the still through its transform - so the real capturePhoto
 * runs every step: the video frame, the reference, the still, both rotations,
 * the alignment, and the final crop. The final crop's transform is then mapped
 * back into the scene and compared with the region the camera approved.
 *
 * The fallbacks are tested as carefully as the success. Each one is a way a
 * tablet in the field could behave, and each must end with today's video
 * frame rather than an error or a wrong photograph.
 */

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeScene(seed) {
  const rand = random(seed);
  const blobs = Array.from({ length: 40 }, () => ({
    x: -400 + rand() * 2800,
    y: -400 + rand() * 1900,
    sigma: 30 + rand() * 150,
    amplitude: (rand() - 0.5) * 140,
  }));
  return (x, y) => {
    let value = 110 + 0.02 * x + 0.015 * y;
    for (const blob of blobs) {
      const dx = x - blob.x;
      const dy = y - blob.y;
      value += blob.amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * blob.sigma * blob.sigma));
    }
    const bx = (x - 960) / 150;
    const by = (y - 620) / 380;
    if (bx * bx + by * by < 1) value -= 70;
    return value;
  };
}

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return (x, y) => ({
    x: (d * (x - e) - c * (y - f)) / det,
    y: (-b * (x - e) + a * (y - f)) / det,
  });
}

const VIDEO = { videoWidth: 1920, videoHeight: 1080 };
const SINGLE = { x: 348, y: 22, width: 1224, height: 1037 };

/**
 * A simulated browser. `still` describes the camera's still photographs:
 * the raw size it delivers, which way up it hands them over, and how its
 * field of view relates to the video (`truth`, in the oriented still).
 */
function fakeBrowser({
  scene,
  stillScene = scene,
  still = null,
  capabilities = { imageWidth: { max: 4000 }, imageHeight: { max: 3000 } },
  takePhoto = 'ok',
  timeoutMs = 3000,
}) {
  const canvases = [];
  const calls = { takePhoto: [], constructed: 0, closed: 0 };

  const stillValue = still ? (() => {
    const oriented = orientedSize(still.raw, still.rotation);
    const toOriented = drawTransform(still.raw, still.rotation, { x: 0, y: 0, ...oriented }, oriented);
    return (X, Y) => {
      const o = applyTransform(toOriented, X, Y);
      return stillScene((o.x - still.truth.offsetX) / still.truth.scale, (o.y - still.truth.offsetY) / still.truth.scale);
    };
  })() : null;

  const createCanvas = () => {
    const canvas = {
      id: canvases.length,
      width: 0,
      height: 0,
      transform: [1, 0, 0, 1, 0, 0],
      draws: [],
      getContext() { return context; },
      toBlob(callback, type) {
        callback(new Blob([JSON.stringify({ canvas: canvas.id })], { type }));
      },
    };
    const context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      setTransform(...matrix) { canvas.transform = matrix; },
      drawImage(source, ...args) { canvas.draws.push({ source, args, transform: canvas.transform }); },
      getImageData(_x, _y, width, height) {
        const draw = canvas.draws.at(-1);
        const data = new Uint8ClampedArray(width * height * 4);
        const sub = 5;
        let value;
        if (draw.args.length === 8) {
          // drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh)
          const [sx, sy, sw, sh, dx, dy, dw, dh] = draw.args;
          value = (px, py) => scene(sx + ((px - dx) * sw) / dw, sy + ((py - dy) * sh) / dh);
        } else {
          const back = invert(draw.transform);
          value = (px, py) => {
            const raw = back(px, py);
            return stillValue(raw.x, raw.y);
          };
        }
        for (let py = 0; py < height; py += 1) {
          for (let px = 0; px < width; px += 1) {
            let total = 0;
            for (let j = 0; j < sub; j += 1) {
              for (let i = 0; i < sub; i += 1) total += value(px + (i + 0.5) / sub, py + (j + 0.5) / sub);
            }
            const v = Math.max(0, Math.min(255, total / (sub * sub)));
            const p = (py * width + px) * 4;
            data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
          }
        }
        return { data };
      },
    };
    canvases.push(canvas);
    return canvas;
  };

  class FakeImageCapture {
    constructor() { calls.constructed += 1; }
    async getPhotoCapabilities() { return capabilities; }
    takePhoto(settings) {
      calls.takePhoto.push(settings);
      if (takePhoto === 'reject') return Promise.reject(new Error('camera busy'));
      if (takePhoto === 'hang') return new Promise(() => {});
      return Promise.resolve(new Blob(['still']));
    }
  }

  return {
    canvases,
    calls,
    env: {
      createCanvas,
      createImageBitmap: async () => ({
        width: still.raw.width,
        height: still.raw.height,
        close() { calls.closed += 1; },
      }),
      ImageCapture: still ? FakeImageCapture : null,
      timeoutMs,
    },
  };
}

const liveTrack = (id = 'camera-1') => ({ id, readyState: 'live' });

function centred(stillOriented, relative = 1) {
  const scale = expectedScale(stillOriented, { width: 1920, height: 1080 }) * relative;
  return {
    scale,
    offsetX: (stillOriented.width - scale * 1920) / 2,
    offsetY: (stillOriented.height - scale * 1080) / 2,
  };
}

/** Maps the returned photograph's crop back into the scene. */
async function photographedRegion(browser, photo, still) {
  const { canvas: id } = JSON.parse(await photo.blob.text());
  const canvas = browser.canvases[id];
  const draw = canvas.draws.at(-1);
  const back = invert(draw.transform);
  const oriented = orientedSize(still.raw, still.rotation);
  const toOriented = drawTransform(still.raw, still.rotation, { x: 0, y: 0, ...oriented }, oriented);
  const toScene = (px, py) => {
    const raw = back(px, py);
    const o = applyTransform(toOriented, raw.x, raw.y);
    return { x: (o.x - still.truth.offsetX) / still.truth.scale, y: (o.y - still.truth.offsetY) / still.truth.scale };
  };
  const topLeft = toScene(0, 0);
  const bottomRight = toScene(canvas.width, canvas.height);
  return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y, canvas };
}

function assertSameRegion(found, wanted, label) {
  const tolerance = 0.015 * Math.max(wanted.width, wanted.height);
  for (const [edge, a, b] of [
    ['left', found.x, wanted.x],
    ['top', found.y, wanted.y],
    ['right', found.x + found.width, wanted.x + wanted.width],
    ['bottom', found.y + found.height, wanted.y + wanted.height],
  ]) {
    assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${edge} edge off by ${Math.abs(a - b).toFixed(1)} video px`);
  }
}

test('without a still camera the photograph is exactly the video frame it always was', async () => {
  const browser = fakeBrowser({ scene: makeScene(1) });
  const state = createStillCaptureState();
  const photo = await capturePhoto(
    { video: VIDEO, track: liveTrack(), region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state },
    browser.env,
  );
  assert.equal(photo.source, 'video');
  assert.equal(photo.width, 1224);
  assert.equal(photo.height, 1037);
  // The first canvas is the video frame, drawn from the approved region.
  const [frame] = browser.canvases;
  assert.deepEqual(frame.draws[0].args, [348, 22, 1224, 1037, 0, 0, 1224, 1037]);
  assert.equal(JSON.parse(await photo.blob.text()).canvas, frame.id);
  assert.equal(state.lastSource, 'video');
});

test('a still is used, at up to 2048, cropped to exactly the approved region', async () => {
  const raw = { width: 4000, height: 3000 };
  const still = { raw, rotation: 0, truth: centred(raw) };
  const browser = fakeBrowser({ scene: makeScene(2), still });
  const state = createStillCaptureState();

  const photo = await capturePhoto(
    { video: VIDEO, track: liveTrack(), region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state },
    browser.env,
  );

  assert.equal(photo.source, 'still');
  assert.equal(Math.max(photo.width, photo.height), 2048, 'as large as the server keeps');
  assert.ok(photo.width > 1224 * 1.5, `only ${photo.width}px wide`);
  assertSameRegion(await photographedRegion(browser, photo, still), SINGLE, 'upright');
  assert.deepEqual(browser.calls.takePhoto[0], { imageWidth: 4000, imageHeight: 3000 });
  assert.equal(browser.calls.closed, 1, 'the decoded still must be released');
  assert.equal(state.lastSource, 'still');
});

test('a group photograph keeps up to 3072', async () => {
  const raw = { width: 4000, height: 3000 };
  const still = { raw, rotation: 0, truth: centred(raw) };
  const browser = fakeBrowser({ scene: makeScene(3), still });
  const region = { x: 133, y: 0, width: 1654, height: 1080 };
  const photo = await capturePhoto(
    { video: VIDEO, track: liveTrack(), region, maxDimension: GROUP_UPLOAD_MAX_DIMENSION, quality: 0.9, state: createStillCaptureState() },
    browser.env,
  );
  assert.equal(photo.source, 'still');
  assert.equal(photo.width, 3072);
  assertSameRegion(await photographedRegion(browser, photo, still), region, 'group');
});

test('a still handed over sideways is turned the right way up', async () => {
  // A portrait still for a landscape video: the camera ignored the device's
  // orientation. Either quarter turn could be right; the alignment decides.
  for (const rotation of [90, 270]) {
    const raw = { width: 3000, height: 4000 };
    const still = { raw, rotation, truth: centred(orientedSize(raw, rotation)) };
    const browser = fakeBrowser({ scene: makeScene(4), still });
    const photo = await capturePhoto(
      { video: VIDEO, track: liveTrack(), region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state: createStillCaptureState() },
      browser.env,
    );
    assert.equal(photo.source, 'still', `rotation ${rotation} was not recovered`);
    assertSameRegion(await photographedRegion(browser, photo, still), SINGLE, `rotation ${rotation}`);
  }
});

test('a still that shows something else is not used, and the video frame is', async () => {
  const raw = { width: 4000, height: 3000 };
  const still = { raw, rotation: 0, truth: centred(raw) };
  const browser = fakeBrowser({ scene: makeScene(5), stillScene: makeScene(6), still });
  const state = createStillCaptureState();
  const photo = await capturePhoto(
    { video: VIDEO, track: liveTrack(), region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state },
    browser.env,
  );
  assert.equal(photo.source, 'video');
  assert.equal(photo.width, 1224);
  assert.equal(state.misses, 1);
  assert.equal(browser.calls.closed, 1, 'released even when unused');
});

test('a camera whose stills keep failing stops being asked, until it is reopened', async () => {
  const raw = { width: 4000, height: 3000 };
  const still = { raw, rotation: 0, truth: centred(raw) };
  const browser = fakeBrowser({ scene: makeScene(7), still, takePhoto: 'reject' });
  const state = createStillCaptureState();
  const capture = (track) => capturePhoto(
    { video: VIDEO, track, region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state },
    browser.env,
  );

  for (let i = 0; i < MAX_STILL_FAILURES; i += 1) {
    assert.equal((await capture(liveTrack())).source, 'video');
  }
  assert.equal(state.disabled, true);
  const asked = browser.calls.takePhoto.length;
  assert.equal((await capture(liveTrack())).source, 'video');
  assert.equal(browser.calls.takePhoto.length, asked, 'a disabled camera must not be asked again');

  // Reopened - a new track - it gets a fresh chance.
  await capture(liveTrack('camera-2'));
  assert.equal(browser.calls.takePhoto.length, asked + 1);
});

test('a still that never arrives is abandoned for the video frame', async () => {
  const raw = { width: 4000, height: 3000 };
  const still = { raw, rotation: 0, truth: centred(raw) };
  const browser = fakeBrowser({ scene: makeScene(8), still, takePhoto: 'hang', timeoutMs: 30 });
  const started = Date.now();
  const photo = await capturePhoto(
    { video: VIDEO, track: liveTrack(), region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state: createStillCaptureState() },
    browser.env,
  );
  assert.equal(photo.source, 'video');
  assert.ok(Date.now() - started < 1000, 'the wait must be bounded');
});

test('a camera whose stills are no bigger than its video never takes one', async () => {
  // A desktop webcam, typically: the wait would buy nothing.
  const raw = { width: 1920, height: 1080 };
  const still = { raw, rotation: 0, truth: centred(raw) };
  const browser = fakeBrowser({
    scene: makeScene(9),
    still,
    capabilities: { imageWidth: { max: 1920 }, imageHeight: { max: 1080 } },
  });
  const state = createStillCaptureState();
  const photo = await capturePhoto(
    { video: VIDEO, track: liveTrack(), region: SINGLE, maxDimension: SINGLE_UPLOAD_MAX_DIMENSION, quality: 0.92, state },
    browser.env,
  );
  assert.equal(photo.source, 'video');
  assert.equal(browser.calls.takePhoto.length, 0);
  assert.equal(state.disabled, true);
});

test('a stopped camera track is not asked for a still', async () => {
  const raw = { width: 4000, height: 3000 };
  const browser = fakeBrowser({ scene: makeScene(10), still: { raw, rotation: 0, truth: centred(raw) } });
  const photo = await capturePhoto(
    { video: VIDEO, track: { id: 'camera-1', readyState: 'ended' }, region: SINGLE, maxDimension: 2048, quality: 0.92, state: createStillCaptureState() },
    browser.env,
  );
  assert.equal(photo.source, 'video');
  assert.equal(browser.calls.constructed, 0);
});

test('the running record: errors and misses are counted apart, success clears both', () => {
  const state = createStillCaptureState();
  recordStillOutcome(state, 'miss');
  recordStillOutcome(state, 'failure');
  assert.equal(state.misses, 1);
  assert.equal(state.failures, 1);
  recordStillOutcome(state, 'used');
  assert.equal(state.misses + state.failures, 0);
  for (let i = 0; i < MAX_STILL_MISSES - 1; i += 1) recordStillOutcome(state, 'miss');
  assert.equal(state.disabled, false, 'one short of the limit');
  recordStillOutcome(state, 'miss');
  assert.equal(state.disabled, true);
});

test('the still size asked for is the largest, capped at twelve megapixels', () => {
  const video = { width: 1920, height: 1080 };
  assert.deepEqual(
    decidePhotoSettings({ imageWidth: { max: 8000 }, imageHeight: { max: 6000 } }, video),
    { usable: true, settings: { imageWidth: 4032, imageHeight: 3024 } },
  );
  assert.deepEqual(
    decidePhotoSettings({ imageWidth: { max: 4000 }, imageHeight: { max: 3000 } }, video),
    { usable: true, settings: { imageWidth: 4000, imageHeight: 3000 } },
  );
  assert.deepEqual(decidePhotoSettings(null, video), { usable: true, settings: null }, 'unknown: let the browser choose');
  assert.equal(decidePhotoSettings({ imageWidth: { max: 1920 }, imageHeight: { max: 1080 } }, video).usable, false);
});

test('both cameras take their photograph through the still capture, at their own size', () => {
  const single = read('src/components/CameraCapture.tsx');
  assert.match(single, /capturePhoto\(\{/);
  assert.match(single, /maxDimension: SINGLE_UPLOAD_MAX_DIMENSION/);
  const group = read('src/components/GroupCameraCapture.tsx');
  assert.match(group, /capturePhoto\(\{/);
  assert.match(group, /maxDimension: GROUP_UPLOAD_MAX_DIMENSION/);
  // The regions they keep are unchanged: the outline for one person, the
  // whole visible preview for a group.
  assert.match(single, /bodyGuideSourceRect\(/);
  assert.match(group, /coverSourceRect\(/);
});

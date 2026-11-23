import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BURST_FRAMES,
  capturePhoto,
  createStillCaptureState,
  FOCUS_PATCH,
  focusPatch,
  patchSharpness,
} from '../src/lib/stillCapture.ts';
import { describeCapture } from '../src/lib/captureInfo.ts';
import { PHOTO_JPEG_QUALITY } from '../src/lib/photoEncoding.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// A camera whose frames differ only in how sharp they are: frame n shows a
// checkerboard whose contrast is `sharpness[n]`. A canvas remembers which
// frame it was drawn from, and a canvas drawn from another canvas inherits it.
function burstCamera(sharpness, { nextFrame = 'ok' } = {}) {
  const video = { videoWidth: 960, videoHeight: 1280, frame: 0 };
  const canvases = [];
  const env = {
    createCanvas() {
      const canvas = {
        id: canvases.length,
        width: 0,
        height: 0,
        frame: null,
        draws: [],
        getContext() { return context; },
        toBlob(callback, type) {
          callback(new Blob([JSON.stringify({ canvas: canvas.id, frame: canvas.frame })], { type }));
        },
      };
      const context = {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        setTransform() {},
        drawImage(source, ...args) {
          canvas.frame = source === video ? video.frame : source.frame;
          canvas.draws.push(args);
        },
        getImageData(_x, _y, width, height) {
          const contrast = sharpness[canvas.frame] ?? 0;
          const data = new Uint8ClampedArray(width * height * 4);
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const value = 128 + ((x + y) % 2 ? contrast : -contrast);
              const p = (y * width + x) * 4;
              data[p] = value; data[p + 1] = value; data[p + 2] = value; data[p + 3] = 255;
            }
          }
          return { data };
        },
      };
      canvases.push(canvas);
      return canvas;
    },
    createImageBitmap: async () => { throw new Error('not used'); },
    ImageCapture: null,
  };
  if (nextFrame === 'ok') env.nextFrame = async () => { video.frame += 1; };
  if (nextFrame === 'broken') env.nextFrame = async () => { throw new Error('camera stopped'); };
  return { env, video, canvases };
}

const REGION = { x: 0, y: 43, width: 960, height: 1193 };
const FACE = [{ left: 0.4, top: 0.1, width: 0.2, height: 0.15 }];

const shoot = (camera, extra = {}) => capturePhoto({
  video: camera.video,
  track: null,
  region: REGION,
  maxDimension: 3072,
  quality: PHOTO_JPEG_QUALITY,
  state: createStillCaptureState(),
  focus: FACE,
  ...extra,
}, camera.env);

test('the photograph is the sharpest of four consecutive frames, not whichever came first', async () => {
  const camera = burstCamera([10, 40, 25, 5]);
  const photo = await shoot(camera);
  assert.equal(BURST_FRAMES, 4);
  assert.equal(camera.video.frame, 3, 'four frames were looked at');
  assert.equal(JSON.parse(await photo.blob.text()).frame, 1, 'the second frame was the sharpest');
  assert.equal(photo.diagnostics.frames, 4);
  assert.equal(photo.diagnostics.picked, 2);
  assert.ok(photo.diagnostics.sharpness > 0);
  assert.equal(photo.width, 960);
  assert.equal(photo.height, 1193);
});

test('a first frame that is already the sharpest is kept, and a later equal one does not replace it', async () => {
  const first = burstCamera([50, 20, 30, 10]);
  assert.equal(JSON.parse(await (await shoot(first)).blob.text()).frame, 0);
  const level = burstCamera([30, 30, 30, 30]);
  const photo = await shoot(level);
  assert.equal(JSON.parse(await photo.blob.text()).frame, 0);
  assert.equal(photo.diagnostics.picked, 1);
});

test('sharpness is read where the face is, at the size of the photograph itself', async () => {
  const camera = burstCamera([10, 40, 25, 5]);
  await shoot(camera);
  const probe = camera.canvases.find((canvas) => canvas.draws.some((args) => args.length === 8 && args[4] === 0 && args[2] <= FOCUS_PATCH && args[2] === args[6]));
  assert.ok(probe, 'a patch is copied without scaling');
  const [sx, sy, sw, sh, dx, dy, dw, dh] = probe.draws[0];
  assert.deepEqual([dx, dy, dw, dh], [0, 0, sw, sh], 'one photograph pixel for one measured pixel');
  // The face is 192 x 179 px of the 960 x 1193 photograph, starting at 384, 119.
  assert.deepEqual([sx, sy, sw, sh], [384, 119, 192, 178]);
});

test('a face larger than the patch is read in its middle, and a sliver is not read at all', () => {
  const size = { width: 3000, height: 2000 };
  assert.deepEqual(
    focusPatch({ left: 0.25, top: 0.25, width: 0.5, height: 0.5 }, size),
    { x: 1500 - FOCUS_PATCH / 2, y: 1000 - FOCUS_PATCH / 2, width: FOCUS_PATCH, height: FOCUS_PATCH },
  );
  assert.equal(focusPatch({ left: 0.5, top: 0.5, width: 0.001, height: 0.2 }, size), null);
  assert.deepEqual(
    focusPatch({ left: 0.9, top: -0.25, width: 0.4, height: 0.375 }, size),
    { x: 2722, y: 0, width: 256, height: 250 },
    'an area running off the picture is cut to it',
  );
});

test('a smeared patch reads lower than a crisp one, and a flat one reads nothing', () => {
  const patch = (value) => {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const v = value(x, y);
        const p = (y * 32 + x) * 4;
        data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
      }
    }
    return patchSharpness(data, 32, 32);
  };
  const crisp = patch((x) => (x % 8 < 4 ? 40 : 200));
  const smeared = patch((x) => 120 + 80 * Math.sin((x / 8) * Math.PI * 2));
  assert.ok(crisp > smeared * 1.5, `${crisp} against ${smeared}`);
  assert.equal(patch(() => 128), 0);
  assert.equal(patchSharpness(new Uint8ClampedArray(4), 1, 1), 0);
});

test('with several faces the frame kept is the one in which the worst face is best', async () => {
  // Frame 0: everything fairly sharp. Frame 1: sharper overall but for the
  // patch read second, which is smeared because that person moved.
  const video = { videoWidth: 960, videoHeight: 1280, frame: 0 };
  const perFace = [[30, 30], [60, 4], [20, 20], [10, 10]];
  const canvases = [];
  const env = {
    createCanvas() {
      const canvas = { id: canvases.length, width: 0, height: 0, frame: null, reads: 0 };
      const context = {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        setTransform() {},
        drawImage(source) {
          const next = source === video ? video.frame : source.frame;
          if (next !== canvas.frame) canvas.reads = 0;
          canvas.frame = next;
        },
        getImageData(_x, _y, width, height) {
          const contrast = perFace[canvas.frame][canvas.reads % 2];
          canvas.reads += 1;
          const data = new Uint8ClampedArray(width * height * 4);
          for (let i = 0; i < width * height; i += 1) {
            const value = 128 + (((i % width) + Math.floor(i / width)) % 2 ? contrast : -contrast);
            data[i * 4] = value; data[i * 4 + 1] = value; data[i * 4 + 2] = value; data[i * 4 + 3] = 255;
          }
          return { data };
        },
      };
      canvas.getContext = () => context;
      canvas.toBlob = (callback, type) => callback(new Blob([JSON.stringify({ frame: canvas.frame })], { type }));
      canvases.push(canvas);
      return canvas;
    },
    createImageBitmap: async () => { throw new Error('not used'); },
    ImageCapture: null,
    nextFrame: async () => { video.frame += 1; },
  };
  const photo = await capturePhoto({
    video,
    track: null,
    region: REGION,
    maxDimension: 3072,
    quality: PHOTO_JPEG_QUALITY,
    state: createStillCaptureState(),
    focus: [
      { left: 0.1, top: 0.1, width: 0.2, height: 0.15 },
      { left: 0.6, top: 0.1, width: 0.2, height: 0.15 },
    ],
  }, env);
  assert.equal(JSON.parse(await photo.blob.text()).frame, 0, 'one blurred face rules a frame out');
});

test('a camera that cannot announce frames, or stops, still gives the photograph it always did', async () => {
  const plain = burstCamera([10, 40, 25, 5], { nextFrame: 'none' });
  const single = await shoot(plain);
  assert.equal(JSON.parse(await single.blob.text()).frame, 0);
  assert.equal(plain.canvases.length, 1, 'one canvas, one frame, as before');
  assert.equal('frames' in single.diagnostics, false);

  const broken = burstCamera([10, 40, 25, 5], { nextFrame: 'broken' });
  const photo = await shoot(broken);
  assert.equal(JSON.parse(await photo.blob.text()).frame, 0);
  assert.equal('frames' in photo.diagnostics, false);

  const one = burstCamera([10, 40], { nextFrame: 'ok' });
  await shoot(one, { frames: 1 });
  assert.equal(one.video.frame, 0, 'asked for one frame, looked at one');
});

test('the frames not kept are let go of, so a tablet running all day does not fill up', async () => {
  const camera = burstCamera([10, 40, 25, 5]);
  const photo = await shoot(camera);
  const kept = JSON.parse(await photo.blob.text()).canvas;
  const others = camera.canvases.filter((canvas) => canvas.id !== kept);
  assert.equal(others.length, 2, 'one spare frame and the patch reader');
  for (const canvas of others) assert.deepEqual([canvas.width, canvas.height], [0, 0]);
  assert.deepEqual([camera.canvases[kept].width, camera.canvases[kept].height], [960, 1193]);
});

test('a sideways camera gets the same choice of frames, turned upright', async () => {
  const camera = burstCamera([5, 10, 45, 20]);
  const photo = await shoot(camera, { turn: 90 });
  assert.equal(JSON.parse(await photo.blob.text()).frame, 2);
  assert.equal(photo.width, 1193);
  assert.equal(photo.height, 960);
  assert.equal(photo.diagnostics.turn, 90);
  assert.equal(photo.diagnostics.picked, 3);
});

test('the server is told how many frames were looked at and which was kept', async () => {
  const camera = burstCamera([10, 40, 25, 5]);
  const info = describeCapture(await shoot(camera), null, 'test');
  assert.equal(info.frames, 4);
  assert.equal(info.picked, 2);
  assert.equal(typeof info.sharpness, 'number');
});

test('both cameras tell the capture where the faces are, and the group photo is no longer saved at lower quality', () => {
  for (const path of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    const camera = read(path);
    assert.match(camera, /focus: focusRef\.current,/, `${path} photographs without saying where the faces are`);
    assert.match(camera, /focusRef\.current = \w+\.focus \?\? \[\];/, `${path} never learns where the faces are`);
  }
  const group = read('src/components/GroupCameraCapture.tsx');
  assert.match(group, /quality: PHOTO_JPEG_QUALITY,/);
  assert.ok(!/quality: 0\.9\b/.test(group), 'the group photograph was saved at 90%');
  assert.equal(PHOTO_JPEG_QUALITY, 0.95);
});

test('the group screen sends the camera report with its photograph, as the single screen does', () => {
  const camera = read('src/components/GroupCameraCapture.tsx');
  assert.match(camera, /capture: describeCapture\(photo, streamRef\.current\?\.getVideoTracks\(\)\[0\] \?\? null\),/);
  const screen = read('src/components/GroupKioskAttendance.tsx');
  assert.match(screen, /if \(details\?\.capture\) form\.append\(CAPTURE_INFO_FIELD, JSON\.stringify\(details\.capture\)\.slice\(0, 1500\)\);/);
  assert.ok(!screen.includes('BODY_REGIONS_FIELD'), 'body areas belong to one person, not to a group photograph');
});

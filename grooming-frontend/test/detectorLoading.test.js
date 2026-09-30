import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  analysisSize,
  DETECTOR_STARTING_GUIDANCE,
  fullBodyDetectorSettled,
  loadFullBodyDetector,
  modelInputShape,
  MOVENET_MODEL_URL,
  primeFullBodyDetector,
} from '../src/lib/fullBodyDetector.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const publicFile = (path) => new URL(`../public${path}`, import.meta.url);

test('the model is served by this site, in a versioned folder, with every weight file it names', () => {
  assert.equal(MOVENET_MODEL_URL, '/models/movenet-multipose-lightning-v1/model.json');
  const model = JSON.parse(readFileSync(publicFile(MOVENET_MODEL_URL), 'utf8'));
  assert.ok(model.modelTopology, 'a graph model');
  const paths = model.weightsManifest.flatMap((group) => group.paths);
  assert.deepEqual(paths, ['group1-shard1of3.bin', 'group1-shard2of3.bin', 'group1-shard3of3.bin']);
  const folder = MOVENET_MODEL_URL.replace(/model\.json$/, '');
  const sizes = paths.map((path) => statSync(publicFile(folder + path)).size);
  // The sizes Google serves for MultiPose Lightning v1: a truncated copy would
  // load and then fail on the first reading.
  assert.deepEqual(sizes, [4194304, 4194304, 1060230]);
});

test('vercel serves the model as a file and lets browsers keep it for a year', () => {
  const config = JSON.parse(read('vercel.json'));
  const spa = new RegExp(`^${config.rewrites[0].source}$`);
  assert.equal(spa.test(MOVENET_MODEL_URL), false, 'not rewritten to index.html');
  assert.equal(spa.test('/attendance'), true, 'pages still reach the app');
  const models = config.headers.find((rule) => rule.source === '/models/(.*)');
  assert.ok(models, 'a cache rule for /models');
  assert.deepEqual(models.headers, [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]);
});

test('our copy is tried first, Google only if it cannot be reached, then the window shape is prepared', () => {
  const source = read('src/lib/fullBodyDetector.ts').replace(/\r\n/g, '\n');
  const ours = source.indexOf('{ ...config, modelUrl: MOVENET_MODEL_URL }');
  const google = source.indexOf('poseDetection.SupportedModels.MoveNet,\n          config,');
  const prime = source.indexOf('await primeFullBodyDetector(detector, window.innerWidth, window.innerHeight);');
  assert.ok(ours > 0 && google > ours && prime > google, 'ours, then the fallback, then the preparation');
  // Same model settings as before: only where it comes from and how its
  // programs are built have changed.
  assert.match(source, /const MULTI_POSE_MAX_DIMENSION = 320;/);
  assert.match(source, /modelType: poseDetection\.movenet\.modelType\.MULTIPOSE_LIGHTNING,\s*enableTracking: true,\s*multiPoseMaxDimension: MULTI_POSE_MAX_DIMENSION,\s*minPoseScore: 0\.15,/);
  assert.match(source, /tf\.env\(\)\.set\('WEBGL_USE_SHAPES_UNIFORMS', true\);/);
});

test('programs are built in parallel, and compile-only mode is always switched back off', () => {
  const source = read('src/lib/fullBodyDetector.ts').replace(/\r\n/g, '\n');
  assert.match(source, /tf\.env\(\)\.set\('ENGINE_COMPILE_ONLY', true\);\s*try \{\s*output = model\.execute\(input\);\s*\} finally \{\s*\/\/[^\n]*\n\s*tf\.env\(\)\.set\('ENGINE_COMPILE_ONLY', false\);\s*\}/);
  assert.match(source, /await backend\.checkCompileCompletionAsync\(\);\s*backend\.getUniformLocations\(\);/);
  // reset() throws on the multi-person model; only the tracker is reset.
  assert.ok(!/detector\.reset\?\.\(\)/.test(source));
  assert.match(source, /detector\.tracker\?\.reset\?\.\(\);/);
});

test('the picture and network shapes match what readFrame and MoveNet use', () => {
  // A tablet's portrait preview: 480 on the long side, as readFrame draws it.
  assert.deepEqual(analysisSize(736, 850), { width: 416, height: 480 });
  // Already small enough: left as it is.
  assert.deepEqual(analysisSize(300, 400), { width: 300, height: 400 });
  assert.deepEqual(analysisSize(1024, 600), { width: 480, height: 281 });
  // Long side 320, the other rounded up to a multiple of 32.
  assert.deepEqual(modelInputShape(416, 480), [320, 288]);
  assert.deepEqual(modelInputShape(360, 480), [320, 256]);
  assert.deepEqual(modelInputShape(480, 281), [192, 320]);
  assert.deepEqual(modelInputShape(480, 480), [320, 320]);
});

test('each preview shape is prepared once, shared by whoever asks, and never throws', async () => {
  const drawn = [];
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => {
      const canvas = { getContext: () => ({ fillRect: () => {} }) };
      drawn.push(canvas);
      return canvas;
    },
  };
  try {
    let readings = 0;
    let resets = 0;
    const detector = {
      estimatePoses: async (canvas) => { readings += 1; assert.deepEqual([canvas.width, canvas.height], [416, 480]); return []; },
      tracker: { reset: () => { resets += 1; } },
    };
    await Promise.all([
      primeFullBodyDetector(detector, 736, 850),
      primeFullBodyDetector(detector, 736, 850),
    ]);
    await primeFullBodyDetector(detector, 736, 850);
    assert.equal(readings, 1, 'one blank reading for the shape');
    assert.equal(resets, 1, 'tracking starts from nothing');

    const broken = { estimatePoses: async () => { throw new Error('context lost'); } };
    await assert.doesNotReject(primeFullBodyDetector(broken, 500, 700));
    // Nothing to prepare for no detector or a preview not yet laid out.
    await primeFullBodyDetector(null, 736, 850);
    await primeFullBodyDetector(detector, 0, 850);
    assert.equal(readings, 1);
  } finally {
    globalThis.document = previous;
  }
});

test('loading settles even where it fails, so a camera never says it is starting for ever', async () => {
  assert.equal(fullBodyDetectorSettled(), false);
  // No WebGL here: the same null a device without it gets.
  assert.equal(await loadFullBodyDetector(), null);
  assert.equal(fullBodyDetectorSettled(), true);
});

test('Attendance and the check-in card start loading as they open', () => {
  for (const file of ['src/components/AttendanceScreen.tsx', 'src/components/EvaluateCard.tsx']) {
    assert.match(read(file), /useEffect\(\(\) => \{\s*preloadFullBodyDetector\(\);\s*\}, \[\]\);/, file);
  }
});

test('both cameras say they are starting only while the detector has not loaded', () => {
  assert.equal(DETECTOR_STARTING_GUIDANCE, 'Starting face detection…');
  const single = read('src/components/CameraCapture.tsx');
  assert.match(single, /if \(!fullBodyDetectorSettled\(\)\) setGuidance\(DETECTOR_STARTING_GUIDANCE\);\s*const detector = await loadFullBodyDetector\(\);/);
  const group = read('src/components/GroupCameraCapture.tsx');
  assert.match(group, /if \(!fullBodyDetectorSettled\(\)\) \{\s*setReading\(\(current\) => \(\{ \.\.\.current, guidance: DETECTOR_STARTING_GUIDANCE \}\)\);\s*\}\s*const detector = await loadFullBodyDetector\(\);/);
  // The four-second fallback to the manual button is unchanged.
  assert.match(single, /\}, 4_000\);/);
  assert.match(group, /\}, 4_000\);/);
});

test('both cameras prepare their own preview shape after loading, outside the four-second fallback', () => {
  for (const file of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    assert.match(
      read(file),
      /const detector = await loadFullBodyDetector\(\);\s*clearTimeout\(detectorGraceTimer\);\s*(?:\/\/[^\n]*\n\s*)+const preview = viewportRef\.current;\s*if \(preview\) await primeFullBodyDetector\(detector, preview\.clientWidth, preview\.clientHeight\);/,
      file,
    );
  }
});

test('the model folder is part of the build, not ignored by git', () => {
  assert.ok(existsSync(publicFile('/models/movenet-multipose-lightning-v1/model.json')));
  const ignore = read('.gitignore');
  assert.ok(!/^\*\.bin$|^public\/models|^models\//m.test(ignore));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DECISION_INTERVAL_MS,
  FOLLOW_MAX_GAP_MS,
  FOLLOW_MIN_GAP_MS,
  followGap,
  planNextRead,
  smoothedCost,
} from '../src/lib/detectionPace.ts';
import {
  BOX_FOLLOW_AT,
  focusAreas,
  rememberedLabels,
  smoothBoxes,
  stabilizeBoxLabels,
} from '../src/lib/faceBoxes.ts';
import { analysisSize, modelInputShape } from '../src/lib/fullBodyDetector.ts';
import { nativeVideoSize, raiseCameraResolution, videoSizeCandidates } from '../src/lib/cameraStream.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---- How often the picture is looked at ----

test('with nobody in view the camera looks exactly as often as it always did', () => {
  assert.equal(DECISION_INTERVAL_MS, 200);
  assert.deepEqual(planNextRead({ sinceDecisionMs: 0, readCostMs: 60, personInView: false }), { delayMs: 200, quick: false });
  assert.deepEqual(planNextRead({ sinceDecisionMs: 50, readCostMs: 60, personInView: false }), { delayMs: 150, quick: false });
  assert.deepEqual(planNextRead({ sinceDecisionMs: 900, readCostMs: 60, personInView: false }), { delayMs: 0, quick: false });
});

test('with somebody in view the gap between full readings is filled with quick looks at the face', () => {
  // A tablet that needs 60 ms a look: two quick looks, then the full reading on time.
  const cost = 60;
  const first = planNextRead({ sinceDecisionMs: 0, readCostMs: cost, personInView: true });
  assert.deepEqual(first, { delayMs: 30, quick: true });
  const second = planNextRead({ sinceDecisionMs: 30 + cost, readCostMs: cost, personInView: true });
  assert.deepEqual(second, { delayMs: 30, quick: true });
  const third = planNextRead({ sinceDecisionMs: 2 * (30 + cost), readCostMs: cost, personInView: true });
  assert.deepEqual(third, { delayMs: 20, quick: false }, 'the full reading starts at 200 ms, as before');
});

test('a full reading is never pushed back, however slow the tablet', () => {
  for (const cost of [10, 40, 60, 90, 120, 150, 200, 400]) {
    let since = 0;
    let looks = 0;
    for (;;) {
      const plan = planNextRead({ sinceDecisionMs: since, readCostMs: cost, personInView: true });
      if (!plan.quick) {
        assert.equal(since + plan.delayMs, DECISION_INTERVAL_MS, `${cost} ms a look: full reading at ${since + plan.delayMs}`);
        break;
      }
      since += plan.delayMs + cost;
      looks += 1;
      assert.ok(since <= DECISION_INTERVAL_MS, `${cost} ms a look: a quick look overran the full reading`);
    }
    if (cost >= 200) assert.equal(looks, 0, 'a tablet too slow for quick looks behaves as before');
    if (cost <= 60) assert.ok(looks >= 2, `${cost} ms a look should fit at least two quick looks, got ${looks}`);
  }
});

test('the tablet rests between quick looks, within limits', () => {
  assert.equal(followGap(10), FOLLOW_MIN_GAP_MS);
  assert.equal(followGap(80), 40);
  assert.equal(followGap(500), FOLLOW_MAX_GAP_MS);
  assert.equal(followGap(Number.NaN), FOLLOW_MIN_GAP_MS);
  assert.equal(smoothedCost(0, 80), 80, 'the first look is taken as it is');
  assert.equal(smoothedCost(100, 50), 85);
  assert.equal(smoothedCost(100, Number.NaN), 100);
});

test('both cameras keep the full reading on its beat and only move boxes in between', () => {
  for (const path of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    const camera = read(path);
    assert.match(camera, /const plan = planNextRead\(\{\s*sinceDecisionMs: performance\.now\(\) - lastDecisionAt,\s*readCostMs: readCost,\s*personInView,\s*\}\);/, path);
    const quick = camera.indexOf('if (quickNext && video) {');
    const full = camera.indexOf('readWithTurn(tracker, read)');
    assert.ok(quick > 0 && quick < full, `${path}: the quick look must return before the full reading`);
    const between = camera.slice(quick, full);
    assert.match(between, /await read\(tracker\.turn\);/, `${path}: a quick look does not hunt for a sideways camera`);
    assert.match(between, /if \(!firingRef\.current\) \{/, `${path}: no quick looks while the photograph is being taken`);
    for (const decision of ['setVerdict(', 'setReading(', 'stabilizeFrameReading(', 'stabilizeGroupReading(', 'stabilizeBoxLabels(', 'shootRef.current(', 'unusableRef']) {
      assert.ok(!between.includes(decision), `${path}: a quick look must not touch ${decision}`);
    }
    assert.match(camera, /lastDecisionAt = performance\.now\(\);\s*personInView = \(\w+\.boxes\?\.length \?\? 0\) > 0;\s*scheduleNext\(\);/, path);
    assert.ok(!camera.includes('timer = setTimeout(tick, 200);\n      };') && !camera.includes('timer = setTimeout(tick, 200);\r\n      };'), `${path} still waits a fixed 200 ms after every reading`);
  }
});

// ---- The box itself ----

const box = (left, top, width = 0.2, height = 0.26, key = 't1') => ({ key, left, top, width, height, confident: true });

test('a box that really moved jumps straight to the face', () => {
  const moved = smoothBoxes([box(0.2, 0.2)], [box(0.3, 0.2)]);
  assert.deepEqual(moved, [box(0.3, 0.2)], 'half a box width is a real movement');
  assert.ok(BOX_FOLLOW_AT <= 0.3);
});

test('a still face has a still box: small tremors are eased, not copied', () => {
  const [eased] = smoothBoxes([box(0.2, 0.2)], [box(0.206, 0.2)]);
  assert.ok(eased.left > 0.2 && eased.left < 0.206, `eased to ${eased.left}`);
  assert.ok(eased.left - 0.2 >= 0.006 * 0.45, 'it still follows, by at least the easing share');
  const [same] = smoothBoxes([box(0.2, 0.2)], [box(0.2, 0.2)]);
  assert.deepEqual(same, box(0.2, 0.2));
});

test('a box is only eased against itself, and keeps everything else it was given', () => {
  const next = [{ ...box(0.5, 0.1, 0.2, 0.26, 't9'), label: 'Step back', confident: false }];
  assert.deepEqual(smoothBoxes([box(0.2, 0.2, 0.2, 0.26, 't1')], next), next, 'somebody else: no easing');
  assert.deepEqual(smoothBoxes([], next), next, 'first sight: no easing');
  const [kept] = smoothBoxes([box(0.5, 0.1, 0.2, 0.26, 't9')], [{ ...box(0.502, 0.1, 0.2, 0.26, 't9'), label: 'Step back', confident: false }]);
  assert.equal(kept.label, 'Step back');
  assert.equal(kept.confident, false);
  assert.equal(kept.key, 't9');
  assert.deepEqual(smoothBoxes([box(0.2, 0.2)], []), [], 'a face that left takes its box with it');
});

test('a quick look shows the chips already settled, without counting towards changing them', () => {
  const first = stabilizeBoxLabels({}, [{ ...box(0.1, 0.1, 0.2, 0.26, 't1'), label: 'Step back' }, box(0.6, 0.1, 0.2, 0.26, 't2')]);
  const memoryBefore = JSON.stringify(first.memory);
  const quick = rememberedLabels(first.memory, [
    box(0.12, 0.1, 0.2, 0.26, 't1'),
    { ...box(0.6, 0.1, 0.2, 0.26, 't2'), label: 'Face the camera' },
    { ...box(0.8, 0.1, 0.1, 0.13, 't3'), label: 'Step back' },
  ]);
  assert.equal(quick[0].label, 'Step back', 'the settled chip stays');
  assert.equal('label' in quick[1], false, 'one quick look does not put a chip on');
  assert.equal('label' in quick[2], false, 'a newcomer waits for the next full reading');
  assert.equal(JSON.stringify(first.memory), memoryBefore, 'the chip memory is untouched');
});

test('the faces are handed to the capture in the upright, unmirrored picture', () => {
  const found = [box(0.1, 0.2, 0.2, 0.3)];
  assert.deepEqual(focusAreas(found, false), [{ left: 0.1, top: 0.2, width: 0.2, height: 0.3 }]);
  const mirrored = focusAreas(found, true);
  assert.ok(Math.abs(mirrored[0].left - 0.7) < 1e-9, 'a mirrored preview box is flipped back');
  assert.deepEqual([mirrored[0].top, mirrored[0].width, mirrored[0].height], [0.2, 0.2, 0.3]);
  const single = read('src/lib/fullBodyDetector.ts');
  const group = read('src/lib/groupFrameDetector.ts');
  for (const detector of [single, group]) {
    assert.match(detector, /focus: focusAreas\(found, turn === 0 && Boolean\(options\?\.mirrored\)\),/);
  }
});

test('the box moves in a tenth of a second, to keep up with looks that now come that often', () => {
  const overlay = read('src/components/FaceBoxOverlay.tsx');
  assert.match(overlay, /transition-\[left,top,width,height\] duration-100 ease-linear/);
});

// ---- The size the people are looked for at ----

test('one person and a group are looked for at the same size, the one measured to find them best', () => {
  // A landscape tablet, 1024 x 768, and an upright one.
  assert.deepEqual(analysisSize(1024, 768), { width: 480, height: 360 });
  assert.deepEqual(modelInputShape(480, 360), [256, 320]);
  assert.deepEqual(modelInputShape(360, 480), [320, 256]);
  const single = read('src/lib/fullBodyDetector.ts');
  const group = read('src/lib/groupFrameDetector.ts');
  assert.match(single, /const MULTI_POSE_MAX_DIMENSION = 320;/);
  assert.match(group, /Math\.min\(1, 480 \/ Math\.max\(crop\.width, crop\.height\)\)/);
  for (const source of [single, group]) {
    assert.ok(!source.includes('multiPoseMaxDimension ='), 'the model size is not changed from screen to screen');
  }
});

// ---- The camera's own largest size ----

test('a camera whose largest size is not a standard one is opened at that size', async () => {
  // The 7 MP tablet camera: 3088 x 2316, held upright.
  assert.deepEqual(nativeVideoSize(3088, 2316), [3088, 2316]);
  assert.deepEqual(nativeVideoSize(2316, 3088), [3088, 2316]);
  const upright = videoSizeCandidates({ width: { max: 3088 }, height: { max: 2316 } }, { width: 1440, height: 1920 });
  assert.deepEqual(upright.map((s) => `${s.width}x${s.height}`), ['2316x3088', '1920x2560', '1440x2560']);

  let size = { width: 1440, height: 1920 };
  const tried = [];
  const track = {
    getCapabilities: () => ({ width: { max: 3088 }, height: { max: 2316 } }),
    getSettings: () => ({ ...size }),
    applyConstraints: async (constraints) => {
      const next = { width: constraints.width.exact, height: constraints.height.exact };
      tried.push(`${next.width}x${next.height}`);
      size = next;
    },
  };
  assert.deepEqual(await raiseCameraResolution(track), { width: 2316, height: 3088 });
  assert.deepEqual(tried, ['2316x3088'], 'the full 7 MP, not the 4.9 MP it stopped at before');
});

test('only a real camera shape counts as its largest size, and never above the cap', () => {
  assert.equal(nativeVideoSize(1920, 1920), null, 'largest width and largest height reported separately');
  assert.equal(nativeVideoSize(8000, 6000), null, 'above the cap: the listed sizes are used');
  assert.equal(nativeVideoSize(0, 0), null);
  assert.deepEqual(nativeVideoSize(1280, 960), [1280, 960]);
  const listed = videoSizeCandidates({ width: { max: 3840 }, height: { max: 2160 } }, { width: 1280, height: 720 });
  assert.deepEqual(listed.map((s) => `${s.width}x${s.height}`), ['3840x2160', '2560x1920', '2560x1440', '1920x1440', '1920x1080'], 'a listed size is not tried twice');
  assert.deepEqual(videoSizeCandidates({ width: { max: 1280 }, height: { max: 960 } }, { width: 960, height: 1280 }), [], 'the 1.2 MP tablet is already at its largest');
});

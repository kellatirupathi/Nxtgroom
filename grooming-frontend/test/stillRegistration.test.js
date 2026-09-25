import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTransform,
  candidateRotations,
  chooseMapping,
  drawTransform,
  expectedScale,
  fitWithin,
  mapRegion,
  MIN_MATCH_SCORE,
  orientedSize,
  referenceGridSize,
  regionFits,
  registerStill,
  thumbnailScale,
  worthUsing,
} from '../src/lib/stillRegistration.ts';

/**
 * Aligning a full-resolution still against the video frame the camera approved.
 *
 * Every test builds a synthetic scene, photographs it twice - once as the
 * video would, once as a still with a known field of view, offset and
 * exposure - and checks that the alignment recovers what was done, or refuses
 * when it should. The refusals matter as much as the recoveries: each one is a
 * way a still could show something other than what the camera approved, and
 * refusing means the video frame is used, exactly as before this feature.
 */

/** Seeded, so a failure reproduces. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * A scene: soft background blobs at several sizes, and a person standing in
 * the middle. Defined over the whole plane, because a still can see beyond the
 * video's edges.
 */
function makeScene(seed = 1, { person = true, blank = false } = {}) {
  const rand = random(seed);
  const blobs = Array.from({ length: 45 }, () => ({
    x: -400 + rand() * 2800,
    y: -400 + rand() * 1900,
    sigma: 25 + rand() * 160,
    amplitude: (rand() - 0.5) * 140,
  }));
  return (x, y) => {
    if (blank) return 128;
    let value = 110 + 0.02 * x + 0.015 * y;
    for (const blob of blobs) {
      const dx = x - blob.x;
      const dy = y - blob.y;
      value += blob.amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * blob.sigma * blob.sigma));
    }
    if (person) {
      // Body and head, dark against the background.
      const bx = (x - 960) / 150;
      const by = (y - 620) / 380;
      if (bx * bx + by * by < 1) value -= 70;
      const hx = (x - 960) / 70;
      const hy = (y - 190) / 85;
      if (hx * hx + hy * hy < 1) value += 40;
    }
    return value;
  };
}

/** Averages the scene over a rectangle, as a camera pixel would. */
function average(scene, x0, y0, x1, y1, samples) {
  let total = 0;
  for (let j = 0; j < samples; j += 1) {
    for (let i = 0; i < samples; i += 1) {
      total += scene(x0 + ((i + 0.5) * (x1 - x0)) / samples, y0 + ((j + 0.5) * (y1 - y0)) / samples);
    }
  }
  return total / (samples * samples);
}

/** The reference: the video region, rendered at the grid size the capture uses. */
function renderReference(scene, region) {
  const { width, height } = referenceGridSize(region);
  const data = new Float32Array(width * height);
  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const x0 = region.x + (i * region.width) / width;
      const y0 = region.y + (j * region.height) / height;
      data[j * width + i] = average(
        scene, x0, y0,
        x0 + region.width / width, y0 + region.height / height, 6,
      );
    }
  }
  return { data, width, height };
}

/**
 * The still, right way up, rendered as the small thumbnail the capture makes.
 * `truth` maps video pixels to still pixels; `tone` is a different camera
 * pipeline's exposure; `noise` its grain.
 */
function renderStill(scene, { stillSize, video, region, truth, tone = (v) => v, noise = 0, seed = 9, flip = false }) {
  const k = thumbnailScale(stillSize, video, region);
  const width = Math.max(8, Math.round(stillSize.width * k));
  const height = Math.max(8, Math.round(stillSize.height * k));
  const kx = width / stillSize.width;
  const ky = height / stillSize.height;
  const rand = random(seed);
  const data = new Float32Array(width * height);
  for (let q = 0; q < height; q += 1) {
    for (let p = 0; p < width; p += 1) {
      // Still pixels this thumbnail pixel covers, then the scene there.
      const sx0 = p / kx; const sx1 = (p + 1) / kx;
      const sy0 = q / ky; const sy1 = (q + 1) / ky;
      const value = average(
        scene,
        (sx0 - truth.offsetX) / truth.scale, (sy0 - truth.offsetY) / truth.scale,
        (sx1 - truth.offsetX) / truth.scale, (sy1 - truth.offsetY) / truth.scale,
        4,
      );
      const index = flip ? (height - 1 - q) * width + (width - 1 - p) : q * width + p;
      data[index] = tone(value) + (rand() - 0.5) * 2 * noise;
    }
  }
  return { data, width, height };
}

/** A truth: the centred model, times a field-of-view factor, plus an offset. */
function truthFor(stillSize, video, relative = 1, dx = 0, dy = 0) {
  const scale = expectedScale(stillSize, video) * relative;
  return {
    scale,
    offsetX: (stillSize.width - scale * video.width) / 2 + dx * stillSize.width,
    offsetY: (stillSize.height - scale * video.height) / 2 + dy * stillSize.height,
  };
}

const VIDEO = { width: 1920, height: 1080 };
const STILL = { width: 4000, height: 3000 };
/** The one-person outline on a landscape tablet, in video pixels. */
const SINGLE = { x: 348, y: 22, width: 1224, height: 1037 };
/** The whole visible preview, as the group camera keeps it. */
const GROUP = { x: 133, y: 0, width: 1654, height: 1080 };

function assertRecovers(mapping, truth, region, label) {
  assert.ok(mapping, `${label}: no alignment found`);
  assert.equal(mapping.atSearchEdge, false, `${label}: landed on the search edge`);
  assert.ok(mapping.score >= 0.9, `${label}: score ${mapping.score.toFixed(3)}`);
  const found = mapRegion(region, mapping);
  const wanted = mapRegion(region, truth);
  // Within 1.5% of the region's own size on every edge: a few pixels in a
  // crop thousands of pixels across.
  const tolerance = 0.015 * Math.max(wanted.width, wanted.height);
  for (const [name, a, b] of [
    ['left', found.x, wanted.x],
    ['top', found.y, wanted.y],
    ['right', found.x + found.width, wanted.x + wanted.width],
    ['bottom', found.y + found.height, wanted.y + wanted.height],
  ]) {
    assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${name} edge off by ${Math.abs(a - b).toFixed(1)}px`);
  }
}

test('a still with the usual field of view is lined up exactly', () => {
  const scene = makeScene(1);
  for (const [label, region] of [['one person', SINGLE], ['group', GROUP]]) {
    const truth = truthFor(STILL, VIDEO);
    const mapping = registerStill({
      region,
      reference: renderReference(scene, region),
      video: VIDEO,
      still: renderStill(scene, { stillSize: STILL, video: VIDEO, region, truth }),
      stillSize: STILL,
    });
    assertRecovers(mapping, truth, region, label);
  }
});

test('a different exposure and some grain do not throw the alignment off', () => {
  // A still goes through a different pipeline from the video: brighter,
  // flatter, noisier. Correlation is blind to the first two by construction.
  const scene = makeScene(2);
  const truth = truthFor(STILL, VIDEO);
  const mapping = registerStill({
    region: SINGLE,
    reference: renderReference(scene, SINGLE),
    video: VIDEO,
    still: renderStill(scene, {
      stillSize: STILL, video: VIDEO, region: SINGLE, truth,
      tone: (v) => 0.7 * v + 45, noise: 6,
    }),
    stillSize: STILL,
  });
  assertRecovers(mapping, truth, SINGLE, 'exposure');
});

test('a video that is a stabilised crop of the sensor is found wherever it sits', () => {
  // The still sees a fifth more than the video, and the stabiliser has pushed
  // the video window off centre.
  const scene = makeScene(3);
  const truth = truthFor(STILL, VIDEO, 1.2, 0.03, -0.02);
  const mapping = registerStill({
    region: SINGLE,
    reference: renderReference(scene, SINGLE),
    video: VIDEO,
    still: renderStill(scene, { stillSize: STILL, video: VIDEO, region: SINGLE, truth }),
    stillSize: STILL,
  });
  assertRecovers(mapping, truth, SINGLE, 'stabilised');
  assert.ok(Math.abs(mapping.relativeScale - 1.2) < 0.015, `scale ${mapping.relativeScale}`);
});

test('a still cut narrower than the video is found too', () => {
  const scene = makeScene(4);
  const truth = truthFor(STILL, VIDEO, 0.85);
  const mapping = registerStill({
    region: SINGLE,
    reference: renderReference(scene, SINGLE),
    video: VIDEO,
    still: renderStill(scene, { stillSize: STILL, video: VIDEO, region: SINGLE, truth }),
    stillSize: STILL,
  });
  assertRecovers(mapping, truth, SINGLE, 'narrow');
});

test('a portrait tablet lines up the same way', () => {
  const portraitVideo = { width: 1080, height: 1920 };
  const portraitStill = { width: 3000, height: 4000 };
  const region = { x: 140, y: 38, width: 799, height: 1843 };
  // The scene is laid out for landscape; stand it on its side.
  const landscape = makeScene(5);
  const scene = (x, y) => landscape(y * 0.9, x * 1.1);
  const truth = truthFor(portraitStill, portraitVideo, 0.95, -0.01, 0.01);
  const mapping = registerStill({
    region,
    reference: renderReference(scene, region),
    video: portraitVideo,
    still: renderStill(scene, { stillSize: portraitStill, video: portraitVideo, region, truth }),
    stillSize: portraitStill,
  });
  assertRecovers(mapping, truth, region, 'portrait');
});

test('a still that does not contain the whole approved region is refused', () => {
  // The video reaches past the still's top and bottom, so part of what the
  // camera approved is simply not in the still. The nearest alignment that
  // fits correlates well on a smooth scene - and is a sample off. It must not
  // be used: the region cut from it would not be the region approved.
  const portraitVideo = { width: 1080, height: 1920 };
  const portraitStill = { width: 3000, height: 4000 };
  const region = { x: 140, y: 38, width: 799, height: 1843 };
  const landscape = makeScene(5);
  const scene = (x, y) => landscape(y * 0.9, x * 1.1);
  // Runs off the bottom by about 5% - past the few percent of overhang that
  // is trimmed rather than refused.
  const truth = truthFor(portraitStill, portraitVideo, 1.05, -0.01, 0.05);
  assert.equal(
    regionFits(mapRegion(region, truth), portraitStill),
    false,
    'the premise: the true region runs off the still',
  );
  const mapping = registerStill({
    region,
    reference: renderReference(scene, region),
    video: portraitVideo,
    still: renderStill(scene, { stillSize: portraitStill, video: portraitVideo, region, truth }),
    stillSize: portraitStill,
  });
  assert.equal(chooseMapping([{ rotation: 0, mapping }]), null);
});

test('a still of somewhere else is refused', () => {
  // The reference is one scene and the still another: whatever alignment is
  // "best", it must not be good enough to use.
  const truth = truthFor(STILL, VIDEO);
  const mapping = registerStill({
    region: SINGLE,
    reference: renderReference(makeScene(6), SINGLE),
    video: VIDEO,
    still: renderStill(makeScene(7), { stillSize: STILL, video: VIDEO, region: SINGLE, truth }),
    stillSize: STILL,
  });
  const chosen = chooseMapping([{ rotation: 0, mapping }]);
  assert.equal(chosen, null, `a different scene scored ${mapping?.score?.toFixed(3)}`);
});

test('a still handed over upside down is caught, and the right way up chosen', () => {
  // The capture tries both ways up. Rendered here as the capture would see
  // them: the delivered still (upside down) as rotation 0, and turned half a
  // circle as rotation 180.
  const scene = makeScene(8);
  const truth = truthFor(STILL, VIDEO);
  const reference = renderReference(scene, SINGLE);
  const asDelivered = renderStill(scene, { stillSize: STILL, video: VIDEO, region: SINGLE, truth, flip: true });
  const turned = renderStill(scene, { stillSize: STILL, video: VIDEO, region: SINGLE, truth });

  const chosen = chooseMapping([
    { rotation: 0, mapping: registerStill({ region: SINGLE, reference, video: VIDEO, still: asDelivered, stillSize: STILL }) },
    { rotation: 180, mapping: registerStill({ region: SINGLE, reference, video: VIDEO, still: turned, stillSize: STILL }) },
  ]);
  assert.ok(chosen, 'the right way up should be found');
  assert.equal(chosen.rotation, 180);
});

test('a blank wall has nothing to align on, so nothing is claimed', () => {
  const truth = truthFor(STILL, VIDEO);
  const blank = makeScene(10, { blank: true, person: false });
  const mapping = registerStill({
    region: SINGLE,
    reference: renderReference(blank, SINGLE),
    video: VIDEO,
    still: renderStill(blank, { stillSize: STILL, video: VIDEO, region: SINGLE, truth }),
    stillSize: STILL,
  });
  assert.equal(mapping, null);
});

test('a field of view beyond the searched range is refused, not guessed', () => {
  // The still sees nearly twice what the model expects - outside the range.
  // The best found inside the range cannot be trusted.
  const scene = makeScene(11);
  const truth = truthFor(STILL, VIDEO, 1.9);
  const mapping = registerStill({
    region: SINGLE,
    reference: renderReference(scene, SINGLE),
    video: VIDEO,
    still: renderStill(scene, { stillSize: STILL, video: VIDEO, region: SINGLE, truth }),
    stillSize: STILL,
  });
  assert.equal(chooseMapping([{ rotation: 0, mapping }]), null);
});

test('two candidates too close to call are refused', () => {
  const strong = { scale: 2, offsetX: 0, offsetY: 0, score: 0.93, relativeScale: 1, atSearchEdge: false };
  const close = { ...strong, score: 0.88 };
  assert.equal(chooseMapping([{ rotation: 0, mapping: strong }, { rotation: 180, mapping: close }]), null);
  assert.equal(chooseMapping([{ rotation: 0, mapping: strong }, { rotation: 180, mapping: { ...close, score: 0.4 } }]).rotation, 0);
  assert.equal(chooseMapping([{ rotation: 0, mapping: { ...strong, score: MIN_MATCH_SCORE - 0.01 } }]), null);
  assert.equal(chooseMapping([{ rotation: 0, mapping: { ...strong, atSearchEdge: true } }]), null);
  assert.equal(chooseMapping([{ rotation: 0, mapping: null }, { rotation: 180, mapping: null }]), null);
});

test('alignment is quick enough to run at the moment of capture', () => {
  const scene = makeScene(12);
  const truth = truthFor(STILL, VIDEO);
  const reference = renderReference(scene, GROUP);
  const still = renderStill(scene, { stillSize: STILL, video: VIDEO, region: GROUP, truth });
  const started = performance.now();
  for (let i = 0; i < 2; i += 1) registerStill({ region: GROUP, reference, video: VIDEO, still, stillSize: STILL });
  const perCandidate = (performance.now() - started) / 2;
  // A tablet is several times slower than this machine; two candidates are
  // tried per capture. Generous, to catch a pathological change, not jitter.
  assert.ok(perCandidate < 400, `one alignment took ${perCandidate.toFixed(0)}ms`);
});

test('orientation and shape helpers', () => {
  assert.deepEqual(orientedSize({ width: 4000, height: 3000 }, 90), { width: 3000, height: 4000 });
  assert.deepEqual(orientedSize({ width: 4000, height: 3000 }, 180), { width: 4000, height: 3000 });
  // A landscape still for a landscape video: upright or upside down only.
  assert.deepEqual(candidateRotations({ width: 4000, height: 3000 }, VIDEO), [0, 180]);
  // A landscape still for a portrait video was handed over sideways.
  assert.deepEqual(candidateRotations({ width: 4000, height: 3000 }, { width: 1080, height: 1920 }), [90, 270]);
  assert.ok(Math.abs(expectedScale(STILL, VIDEO) - 4000 / 1920) < 1e-9, 'a 16:9 video fills a 4:3 still across');
  assert.deepEqual(referenceGridSize({ width: 1224, height: 1037 }), { width: 40, height: 34 });
});

test('the upload is capped, never enlarged, and a still must be worth its time', () => {
  assert.deepEqual(fitWithin({ width: 2550, height: 2160 }, 2048), { width: 2048, height: 1735 });
  assert.deepEqual(fitWithin({ width: 800, height: 600 }, 2048), { width: 800, height: 600 });
  // 1224 wide from video; 2550 from a still, capped to 2048: well worth it.
  assert.equal(worthUsing({ width: 2550, height: 2160 }, { width: 1224, height: 1037 }, 2048), true);
  // A still barely larger than the video frame is not.
  assert.equal(worthUsing({ width: 1300, height: 1100 }, { width: 1224, height: 1037 }, 2048), false);
  // Larger only beyond the cap buys nothing either.
  assert.equal(worthUsing({ width: 4000, height: 3000 }, { width: 3000, height: 2250 }, 2048), false);
});

test('a region must lie inside the still to be cut from it', () => {
  assert.equal(regionFits({ x: 0, y: 0, width: 4000, height: 3000 }, STILL), true);
  assert.equal(regionFits({ x: -0.5, y: 10, width: 4000, height: 2000 }, STILL), true, 'rounding is allowed');
  // A few percent of overhang is trimmed; more is not contained.
  assert.equal(regionFits({ x: -20, y: 10, width: 1000, height: 1000 }, STILL), true);
  assert.equal(regionFits({ x: -60, y: 10, width: 1000, height: 1000 }, STILL), false);
  assert.equal(regionFits({ x: 3500, y: 10, width: 1000, height: 1000 }, STILL), false);
});

test('the draw transform turns the raw still the right way and crops it', () => {
  const raw = { width: 4000, height: 3000 };
  const near = (p, x, y) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;

  // Upright, cropped: the region's corners land on the output's corners.
  const crop = drawTransform(raw, 0, { x: 1000, y: 500, width: 2000, height: 1000 }, { width: 1000, height: 500 });
  assert.ok(near(applyTransform(crop, 1000, 500), 0, 0));
  assert.ok(near(applyTransform(crop, 3000, 1500), 1000, 500));

  // A quarter turn clockwise: the raw top-left goes to the oriented top-right.
  const quarter = drawTransform(raw, 90, { x: 0, y: 0, width: 3000, height: 4000 }, { width: 300, height: 400 });
  assert.ok(near(applyTransform(quarter, 0, 0), 300, 0));
  assert.ok(near(applyTransform(quarter, 4000, 0), 300, 400));
  assert.ok(near(applyTransform(quarter, 0, 3000), 0, 0));

  // Three quarters: the raw top-left goes to the oriented bottom-left.
  const threeQuarters = drawTransform(raw, 270, { x: 0, y: 0, width: 3000, height: 4000 }, { width: 300, height: 400 });
  assert.ok(near(applyTransform(threeQuarters, 0, 0), 0, 400));
  assert.ok(near(applyTransform(threeQuarters, 0, 3000), 300, 400));

  // Half a turn: corners swap diagonally.
  const half = drawTransform(raw, 180, { x: 0, y: 0, width: 4000, height: 3000 }, { width: 400, height: 300 });
  assert.ok(near(applyTransform(half, 0, 0), 400, 300));
  assert.ok(near(applyTransform(half, 4000, 3000), 0, 0));
});

test('a region touching the still edge exactly is used, not refused', () => {
  // A camera whose stills are the same shape as its video - 16:9 both - makes
  // the video fill the still exactly, so a group region using the video's full
  // height touches the still's top and bottom. Touching is not overhanging: the
  // region is wholly inside, and refusing it would silently cost every group
  // photograph on such a camera its resolution.
  const wideStill = { width: 4000, height: 2250 };
  const region = { x: 133, y: 0, width: 1654, height: 1080 };
  const scene = makeScene(13);
  const truth = truthFor(wideStill, VIDEO);
  const mapping = registerStill({
    region,
    reference: renderReference(scene, region),
    video: VIDEO,
    still: renderStill(scene, { stillSize: wideStill, video: VIDEO, region, truth }),
    stillSize: wideStill,
  });
  const chosen = chooseMapping([{ rotation: 0, mapping }]);
  assert.ok(chosen, `refused: score ${mapping?.score?.toFixed(3)}, at edge ${mapping?.atSearchEdge}`);
  assertRecovers(mapping, truth, region, 'touching');
  assert.equal(regionFits(mapRegion(region, mapping), wideStill), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bodyRegionsFromKeypoints, BODY_REGIONS_FIELD } from '../src/lib/bodyRegions.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** A man standing upright in a 480 x 640 frame, as MoveNet reports him. */
function standing(overrides = {}) {
  const points = {
    nose: [240, 80], left_eye: [250, 72], right_eye: [230, 72],
    left_shoulder: [280, 150], right_shoulder: [200, 150],
    left_elbow: [295, 230], right_elbow: [185, 230],
    left_wrist: [298, 300], right_wrist: [182, 300],
    left_hip: [265, 310], right_hip: [215, 310],
    left_knee: [262, 440], right_knee: [218, 440],
    left_ankle: [260, 570], right_ankle: [220, 570],
    ...overrides,
  };
  return Object.entries(points)
    .filter(([, value]) => value)
    .map(([name, [x, y]]) => ({ name, x, y, score: 0.9 }));
}

test('the waist band sits around the hips, the legs run to the ankles, the feet below them', () => {
  const regions = bodyRegionsFromKeypoints(standing(), 480, 640);
  // Torso 160px: the waist from 72px above the hips to 40px below, and from
  // 144px to 336px across - hip to hip plus the wrists beside them (182, 298).
  assert.deepEqual(regions.waist, [372, 300, 547, 700]);
  assert.deepEqual(regions.legs, [447, 348, 928, 652]);
  assert.deepEqual(regions.feet, [828, 342, 991, 658]);
  // The head: from above the hair (clamped at the top of the frame) to the
  // collar, centred on the nose, wider than the face.
  assert.deepEqual(regions.head, [0, 378, 240, 622]);
  for (const box of Object.values(regions)) {
    assert.ok(box[0] < box[2] && box[1] < box[3]);
    assert.ok(box.every((value) => value >= 0 && value <= 1000));
  }
});

test('without ankles only the waist is sent; without hips or shoulders nothing is', () => {
  const noAnkles = bodyRegionsFromKeypoints(standing({ left_ankle: null, right_ankle: null }), 480, 640);
  assert.deepEqual(Object.keys(noAnkles), ['head', 'waist']);
  assert.equal(bodyRegionsFromKeypoints(standing({ left_hip: null }), 480, 640), null);
  assert.equal(bodyRegionsFromKeypoints(standing({ right_shoulder: null }), 480, 640), null);
  // Upside down (hips above shoulders) is not a standing person.
  assert.equal(bodyRegionsFromKeypoints(standing({ left_hip: [265, 100], right_hip: [215, 100] }), 480, 640), null);
  assert.equal(bodyRegionsFromKeypoints([], 480, 640), null);
  assert.equal(bodyRegionsFromKeypoints(standing(), 0, 640), null);
});

test('low-confidence joints are not used', () => {
  const points = standing().map((point) => (point.name === 'left_ankle' ? { ...point, score: 0.1 } : point));
  assert.deepEqual(Object.keys(bodyRegionsFromKeypoints(points, 480, 640)), ['head', 'waist']);
});

test('a box running off the frame is clamped to it', () => {
  const regions = bodyRegionsFromKeypoints(standing({ left_ankle: [260, 630], right_ankle: [220, 630] }), 480, 640);
  assert.equal(regions.feet[2], 1000);
  assert.equal(regions.legs[2], 1000);
});

test('the camera hands the areas of the photographed frame to the screens, which send them', () => {
  assert.equal(BODY_REGIONS_FIELD, 'body_regions');
  const detector = source('lib/fullBodyDetector.ts');
  assert.match(detector, /bodyRegions: frameWidth && frameHeight \? bodyRegionsFromKeypoints\(keypoints, frameWidth, frameHeight\) : null,/);
  const camera = source('components/CameraCapture.tsx');
  assert.match(camera, /bodyRegionsRef\.current = reading\.verdict === 'FULL_BODY' \? \(reading\.bodyRegions \?\? null\) : null;/);
  // Snapshotted with the shutter, before the photograph is taken.
  assert.ok(camera.indexOf('const bodyRegions = bodyRegionsRef.current;') < camera.indexOf('const photo = await capturePhoto('));
  assert.match(camera, /\{ type: 'image\/jpeg' \}\), \{ bodyRegions \}\);/);
  assert.match(source('components/KioskAttendance.tsx'), /if \(details\?\.bodyRegions\) form\.append\(BODY_REGIONS_FIELD, JSON\.stringify\(details\.bodyRegions\)\);/);
  const form = source('components/EvaluateCard.tsx');
  assert.equal((form.match(/formData\.append\(BODY_REGIONS_FIELD, JSON\.stringify\(bodyRegions\)\)/g) || []).length, 2, 'check-in and check-out');
  assert.match(form, /setBodyRegions\(null\);/, 'a new or cleared photo forgets the old areas');
});

test('the head box is measured from the eyes to the shoulders, and is skipped without a face', () => {
  const withEars = bodyRegionsFromKeypoints(standing({ left_ear: [262, 78], right_ear: [218, 78] }), 480, 640);
  // Ears 44px apart: the face is 58.5px each side either way here.
  assert.deepEqual(withEars.head, [0, 378, 240, 622]);
  const noFace = bodyRegionsFromKeypoints(standing({ nose: null, left_eye: null, right_eye: null }), 480, 640);
  assert.equal(noFace.head, undefined);
  assert.ok(noFace.waist, 'the rest is still sent');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCapturePosture, postureHoldStart, postureHoldComplete } from '../src/lib/capturePosture.ts';
import { readKeypoints, shutterEnabled } from '../src/lib/fullBodyDetector.ts';

const point = (name, x, y) => ({ name, x, y, score: 0.9 });
const person = [
  point('nose', 120, 80), point('left_eye', 114, 75), point('right_eye', 126, 75),
  point('left_shoulder', 80, 180), point('right_shoulder', 160, 180),
  point('left_elbow', 70, 300), point('right_elbow', 170, 300),
  point('left_wrist', 65, 460), point('right_wrist', 175, 460),
  point('left_hip', 90, 430), point('right_hip', 150, 430),
  point('left_knee', 95, 630), point('right_knee', 145, 630),
  point('left_ankle', 100, 820), point('right_ankle', 140, 820),
];
const change = (name, values) => person.map((p) => p.name === name ? { ...p, ...values } : p);

test('relaxed visible arms are ready at different image scales and mirroring', () => {
  assert.deepEqual(assessCapturePosture(person, 1000, 240), { ready: true, guidance: null });
  assert.equal(assessCapturePosture(person.map((p) => ({ ...p, x: p.x * 2, y: p.y * 2 })), 2000, 480).ready, true);
  assert.equal(assessCapturePosture(person.map((p) => ({ ...p, x: 240 - p.x })), 1000, 240).ready, true);
  assert.equal(readKeypoints(person, 1000, 240).capturePosture.ready, true);
});

test('hands near the face, raised arms, crossed arms and extended arms block auto posture', () => {
  for (const points of [
    change('left_wrist', { y: 90 }), change('right_elbow', { y: 150 }),
    change('left_wrist', { x: 160 }), change('right_wrist', { x: 120 }),
    change('right_wrist', { x: 239 }),
  ]) {
    assert.equal(assessCapturePosture(points, 1000, 240).ready, false);
    const reading = readKeypoints(points, 1000, 240);
    assert.equal(reading.verdict, 'FULL_BODY', 'posture does not change manual framing');
    assert.equal(shutterEnabled(reading.verdict, 0, false), true);
    assert.equal(reading.capturePosture.ready, false);
  }
});

test('missing, uncertain, invalid and cropped arm landmarks require visible hands', () => {
  for (const points of [
    person.filter((p) => p.name !== 'left_elbow'),
    change('right_wrist', { score: 0.1 }), change('left_wrist', { x: NaN }),
    change('right_wrist', { x: 240 }), change('left_wrist', { y: 1000 }),
  ]) {
    const posture = assessCapturePosture(points, 1000, 240);
    assert.equal(posture.ready, false);
    assert.match(posture.guidance, /visible/);
  }
});

test('leaning sideways and strongly tilted shoulders require standing straight', () => {
  assert.match(assessCapturePosture(change('left_shoulder', { y: 250 }), 1000, 240).guidance, /straight/);
  const leaning = person.map((p) => p.name.includes('shoulder') ? { ...p, x: p.x + 70 } : p);
  assert.equal(assessCapturePosture(leaning, 1000, 240).ready, false);
});

test('a full second of continuous valid posture is required and a bad frame restarts it', () => {
  let since = postureHoldStart(true, null, 0);
  assert.equal(postureHoldComplete(since, 999), false);
  assert.equal(postureHoldComplete(since, 1000), true);
  since = postureHoldStart(false, since, 1001);
  assert.equal(postureHoldComplete(since, 5000), false);
  since = postureHoldStart(true, since, 5001);
  assert.equal(postureHoldComplete(since, 6000), false);
  assert.equal(postureHoldComplete(since, 6001), true);
});

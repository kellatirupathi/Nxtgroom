import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurnTracker,
  drawTurned,
  isSideways,
  messageTurn,
  planProbe,
  PROBE_AFTER_WEAK,
  readWithTurn,
  recordProbe,
  rectToFrame,
  setTurn,
  turnedSize,
  turnMatrix,
  UPRIGHT_ENOUGH,
  uprightScore,
} from '../src/lib/frameTurn.ts';

const TURNS = [0, 90, 180, 270];

// Where drawTurned puts a point of the frame region, as fractions of the output.
function landing(turn, region, output, fx, fy) {
  const upright = turnedSize(output, turn);
  const px = fx * upright.width;
  const py = fy * upright.height;
  const [a, b, c, d, e, f] = turn === 0 ? [1, 0, 0, 1, 0, 0] : turnMatrix(turn, output);
  const x = turn === 0 ? fx * output.width : a * px + c * py + e;
  const y = turn === 0 ? fy * output.height : b * px + d * py + f;
  return { u: x / output.width, v: y / output.height };
}

test('a quarter turn swaps width and height, a half turn does not', () => {
  assert.deepEqual(turnedSize({ width: 960, height: 1193 }, 90), { width: 1193, height: 960 });
  assert.deepEqual(turnedSize({ width: 960, height: 1193 }, 270), { width: 1193, height: 960 });
  assert.deepEqual(turnedSize({ width: 960, height: 1193 }, 180), { width: 960, height: 1193 });
  assert.deepEqual(turnedSize({ width: 960, height: 1193 }, 0), { width: 960, height: 1193 });
  assert.deepEqual(TURNS.map(isSideways), [false, true, false, true]);
});

test('turn 0 draws exactly the plain crop it always did', () => {
  const calls = [];
  const context = {
    setTransform: (...m) => calls.push(['setTransform', ...m]),
    drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]),
  };
  drawTurned(context, 'video', { x: 0, y: 43, width: 960, height: 1193 }, 0, { width: 386, height: 480 });
  assert.deepEqual(calls, [['drawImage', 0, 43, 960, 1193, 0, 0, 386, 480]]);
});

test('a turned drawing fills the output exactly and leaves the canvas untransformed', () => {
  for (const turn of [90, 180, 270]) {
    const calls = [];
    const context = {
      setTransform: (...m) => calls.push(['setTransform', ...m]),
      drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]),
    };
    const region = { x: 0, y: 43, width: 960, height: 1193 };
    const output = turnedSize({ width: 386, height: 480 }, turn);
    drawTurned(context, 'video', region, turn, output);
    assert.equal(calls.length, 3, `turn ${turn}`);
    assert.deepEqual(calls.at(-1), ['setTransform', 1, 0, 0, 1, 0, 0], 'the transform must be reset');
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const { u, v } = landing(turn, region, output, fx, fy);
      assert.ok([0, 1].includes(Math.round(u * 1e9) / 1e9) && [0, 1].includes(Math.round(v * 1e9) / 1e9),
        `turn ${turn}: corner ${fx},${fy} landed inside the output at ${u},${v}`);
    }
  }
});

test('turning a quarter clockwise puts heads that lay on the left at the top', () => {
  // The rotated iPad photos: people lie with their heads on the left.
  const { u, v } = landing(90, { x: 0, y: 0, width: 100, height: 100 }, { width: 100, height: 100 }, 0, 0.5);
  assert.ok(Math.abs(u - 0.5) < 1e-9 && Math.abs(v - 0) < 1e-9, `left middle went to ${u},${v}`);
});

test('a box found in the turned picture maps back onto the same spot of the frame', () => {
  for (const turn of TURNS) {
    const region = { x: 0, y: 0, width: 960, height: 1193 };
    const output = turnedSize({ width: 386, height: 480 }, turn);
    // A face in the frame, as fractions of the frame.
    const face = { left: 0.2, top: 0.3, width: 0.1, height: 0.07 };
    const corners = [
      landing(turn, region, output, face.left, face.top),
      landing(turn, region, output, face.left + face.width, face.top + face.height),
    ];
    const seen = {
      left: Math.min(corners[0].u, corners[1].u),
      top: Math.min(corners[0].v, corners[1].v),
      width: Math.abs(corners[0].u - corners[1].u),
      height: Math.abs(corners[0].v - corners[1].v),
    };
    const back = rectToFrame(seen, turn);
    for (const key of ['left', 'top', 'width', 'height']) {
      assert.ok(Math.abs(back[key] - face[key]) < 1e-9, `turn ${turn}: ${key} came back as ${back[key]}, not ${face[key]}`);
    }
  }
});

test('messages turn the way the people appear in the mirrored preview', () => {
  assert.equal(messageTurn(0, true), 0);
  assert.equal(messageTurn(0, false), 0);
  // Heads on the left in the camera frame are on the right in the mirrored
  // preview, so the messages turn clockwise to stand the same way.
  assert.equal(messageTurn(90, true), 90);
  assert.equal(messageTurn(90, false), 270);
  assert.equal(messageTurn(270, true), 270);
  assert.equal(messageTurn(270, false), 90);
  assert.equal(messageTurn(180, true), 180);
});

function standing(x, scale = 1) {
  const point = (name, dx, y, score = 0.9) => ({ name, score, x: x + dx * scale, y: y * scale });
  return {
    keypoints: [
      point('nose', 0, 80), point('left_eye', -6, 75), point('right_eye', 6, 75),
      point('left_ear', -12, 78, 0.7), point('right_ear', 12, 78, 0.7),
      point('left_shoulder', -20, 180), point('right_shoulder', 20, 180),
      point('left_elbow', -26, 300), point('right_elbow', 26, 300),
      point('left_wrist', -28, 410), point('right_wrist', 28, 410),
      point('left_hip', -15, 430), point('right_hip', 15, 430),
      point('left_knee', -12, 630), point('right_knee', 12, 630),
      point('left_ankle', -10, 820), point('right_ankle', 10, 820),
    ],
  };
}

// The same pose as a camera that is turned a quarter would see it: heads on
// the left, as in the photos taken on 19 November.
function lyingDown(pose, frameWidth = 1000) {
  return { keypoints: pose.keypoints.map((p) => ({ ...p, x: p.y, y: frameWidth - p.x })) };
}

test('upright people score; people lying on their side or upside down do not', () => {
  const person = standing(300);
  assert.equal(uprightScore([person]), 17);
  assert.equal(uprightScore([person, standing(600)]), 34, 'every upright person counts');
  assert.equal(uprightScore([lyingDown(person)]), 0);
  const upsideDown = { keypoints: person.keypoints.map((p) => ({ ...p, y: 1000 - p.y })) };
  assert.equal(uprightScore([upsideDown]), 0);
  const faint = { keypoints: person.keypoints.map((p) => ({ ...p, score: 0.2 })) };
  assert.equal(uprightScore([faint]), 0);
  assert.equal(uprightScore(undefined), 0);
  assert.ok(uprightScore([person]) >= UPRIGHT_ENOUGH);
});

test('an upright face or an upright body is each enough on its own', () => {
  const person = standing(300);
  // A face too small to find, on a body standing straight (18 Nov photo).
  const faceless = { keypoints: person.keypoints.filter((p) => !['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'].includes(p.name)) };
  assert.equal(uprightScore([faceless]), 12);
  // Head and one shoulder at the edge of a tight crop (19 Nov photo, turned).
  const headAndShoulder = { keypoints: person.keypoints.filter((p) => ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'right_shoulder'].includes(p.name)) };
  assert.equal(uprightScore([headAndShoulder]), 6);
  // Legs alone say nothing about which way is up.
  const legs = { keypoints: person.keypoints.filter((p) => /hip|knee|ankle/.test(p.name)) };
  assert.equal(uprightScore([legs]), 0);
  // A body leaning further than 40 degrees is lying, not standing.
  const leaning = { keypoints: faceless.keypoints.map((p) => ({ ...p, x: p.x + (p.y - 180) * 1.2 })) };
  assert.equal(uprightScore([leaning]), 0);
  // Eyes stacked one above the other belong to a face on its side.
  const sidewaysFace = {
    keypoints: [
      { name: 'nose', score: 0.9, x: 90, y: 300 },
      { name: 'left_eye', score: 0.9, x: 80, y: 292 },
      { name: 'right_eye', score: 0.9, x: 80, y: 308 },
    ],
  };
  assert.equal(uprightScore([sidewaysFace]), 0);
});

test('nothing else is tried while upright people are seen', () => {
  const tracker = createTurnTracker(0);
  for (let i = 0; i < 20; i += 1) assert.equal(planProbe(tracker, 17), null);
  assert.equal(tracker.turn, 0);
});

test('with nobody upright, other turns are tried on every other frame', () => {
  const tracker = createTurnTracker(0);
  const probes = [];
  for (let i = 0; i < 9; i += 1) probes.push(planProbe(tracker, 0));
  assert.deepEqual(probes.slice(0, PROBE_AFTER_WEAK - 1), Array(PROBE_AFTER_WEAK - 1).fill(null));
  const tried = probes.filter((probe) => probe !== null);
  assert.deepEqual(tried, [90, 270, 180, 90], 'each other turn in order, a quarter each way first');
  assert.equal(probes.filter((probe) => probe === null).length, 5, 'only every other frame');
});

test('a turn is adopted only after it shows upright people twice running', () => {
  const tracker = createTurnTracker(0);
  const changes = [];
  tracker.onChange = (turn) => changes.push(turn);
  let probe;
  do probe = planProbe(tracker, 0); while (probe === null);
  assert.equal(probe, 90);
  assert.equal(recordProbe(tracker, 90, 30, 0), false, 'one good look is not enough');
  do probe = planProbe(tracker, 0); while (probe === null);
  assert.equal(probe, 90, 'the promising turn is looked at again straight away');
  assert.equal(recordProbe(tracker, 90, 30, 0), true);
  assert.equal(tracker.turn, 90);
  assert.deepEqual(changes, [90]);
});

test('a single lucky look at another turn changes nothing', () => {
  const tracker = createTurnTracker(0);
  let probe;
  do probe = planProbe(tracker, 0); while (probe === null);
  recordProbe(tracker, probe, 30, 0);
  do probe = planProbe(tracker, 0); while (probe === null);
  assert.equal(recordProbe(tracker, probe, 2, 0), false);
  assert.equal(tracker.turn, 0);
  assert.equal(tracker.candidate, null);
});

test('a turn that is only a little better is not adopted', () => {
  const tracker = createTurnTracker(0);
  for (let round = 0; round < 6; round += 1) {
    let probe;
    do probe = planProbe(tracker, 6); while (probe === null);
    recordProbe(tracker, probe, 9, 6);
  }
  assert.equal(tracker.turn, 0, 'a margin is needed before trusting another turn');
});

test('setting the turn resets the search and reports the change once', () => {
  const changes = [];
  const tracker = createTurnTracker(90, (turn) => changes.push(turn));
  planProbe(tracker, 0);
  planProbe(tracker, 0);
  setTurn(tracker, 90);
  assert.deepEqual(changes, [], 'no change, no report');
  setTurn(tracker, 0);
  assert.deepEqual(changes, [0]);
  assert.equal(tracker.weak, 0);
  assert.equal(tracker.candidate, null);
});

test('a sideways camera is found and corrected within a few frames', async () => {
  // The camera delivers the group lying down. Reading the frame at a turn
  // stands it back up only when the turn is right.
  const raw = [lyingDown(standing(250)), lyingDown(standing(500)), lyingDown(standing(750))];
  const standUp = (pose, turn) => {
    if (turn === 90) return { keypoints: pose.keypoints.map((p) => ({ ...p, x: 1000 - p.y, y: p.x })) };
    if (turn === 270) return { keypoints: pose.keypoints.map((p) => ({ ...p, x: p.y, y: 1000 - p.x })) };
    if (turn === 180) return { keypoints: pose.keypoints.map((p) => ({ ...p, x: 1000 - p.x, y: 1000 - p.y })) };
    return pose;
  };
  const read = async (turn) => ({ turn, upright: uprightScore(raw.map((pose) => standUp(pose, turn))) });

  const tracker = createTurnTracker(0);
  let result;
  let frames = 0;
  do {
    result = await readWithTurn(tracker, read);
    frames += 1;
  } while (!result.switched && frames < 20);
  assert.equal(result.switched, true, 'the turn was never found');
  assert.equal(tracker.turn, 90);
  assert.equal(result.turn, 90);
  assert.equal(result.reading.turn, 90, 'the upright reading is used at once');
  assert.ok(frames <= 6, `took ${frames} frames`);

  for (let i = 0; i < 10; i += 1) {
    const steady = await readWithTurn(tracker, read);
    assert.equal(steady.turn, 90);
    assert.equal(steady.switched, false);
  }
});

test('an upright camera keeps turn 0 and never pays for extra reads', async () => {
  const people = [standing(300), standing(600)];
  let reads = 0;
  const read = async (turn) => {
    reads += 1;
    return { upright: turn === 0 ? uprightScore(people) : 0 };
  };
  const tracker = createTurnTracker(0);
  for (let i = 0; i < 25; i += 1) await readWithTurn(tracker, read);
  assert.equal(tracker.turn, 0);
  assert.equal(reads, 25, 'one read per frame');
});

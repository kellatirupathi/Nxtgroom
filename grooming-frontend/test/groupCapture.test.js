import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * Group capture, and the promise that it left the single-person screen alone.
 *
 * The first three tests are the promise. Attendance runs on the single-person
 * camera today, at every college, and adding a second mode must not have
 * changed how one person walking up to a tablet is photographed, identified or
 * answered. Read as source rather than as behaviour because that is the level
 * the guarantee was made at: no group symbol in those files at all.
 *
 * The rest are the things this screen can get wrong quietly — a crop that cuts
 * the people off the ends of the group, a shutter that fires again before the
 * first photograph has been answered, or a default that switches everybody to
 * group mode without being asked.
 */

test('the single-person camera knows nothing about groups', () => {
  const camera = read('src/components/CameraCapture.tsx');
  for (const symbol of ['group', 'Group', 'GROUP']) {
    assert.ok(
      !camera.includes(symbol),
      `${symbol} has leaked into the camera every college's attendance runs on`,
    );
  }
});

test('the single-person screen still posts to the single-person route', () => {
  const kiosk = read('src/components/KioskAttendance.tsx');
  assert.match(kiosk, /'\/api\/v2\/attendance\/auto'/);
  assert.ok(
    !kiosk.includes('/auto/group'),
    'the single-person screen must not reach the group endpoint',
  );
  // And it is still the screen it was: one result panel, not a list.
  assert.match(kiosk, /onCapture=\{submit\}/);
});

test('the single-person frame gate still refuses a group', () => {
  // readPoses returning MULTIPLE_PEOPLE is what keeps one person's attendance
  // from being recorded off a photograph of several. The group screen has its
  // own gate precisely so this one did not have to be loosened.
  const detector = read('src/lib/fullBodyDetector.ts');
  assert.match(detector, /verdict: 'MULTIPLE_PEOPLE'/);
  assert.match(detector, /if \(verdict === 'MULTIPLE_PEOPLE' \|\| verdict === 'NO_PERSON'\) return false;/);
});

test('attendance still opens on the single-person screen', () => {
  // Nobody who has not asked for group mode should find their tablet in it.
  const screen = read('src/components/AttendanceScreen.tsx');
  assert.match(screen, /useState<CaptureMode>\('single'\)/);
});

test('the group camera keeps the whole frame, not the standing outline', () => {
  // The single-person camera crops to a tall narrow guide. Using it here would
  // cut the people at both ends out of the photograph — they would be stood in
  // front of the tablet and never recorded.
  const camera = read('src/components/GroupCameraCapture.tsx');
  assert.match(camera, /coverSourceRect\(/);
  assert.ok(
    !camera.includes('bodyGuideSourceRect'),
    'a group does not fit inside a one-person outline',
  );
});

test('the group camera holds its shutter until the whole group is answered', () => {
  // A group request is several check-ins and takes correspondingly longer. If
  // the shutter reopened on encoding rather than on the reply, the second frame
  // would arrive while the first was still being recorded.
  const camera = read('src/components/GroupCameraCapture.tsx');
  assert.match(camera, /await onCapture\(/);
  assert.ok(
    camera.indexOf('await onCapture(') < camera.indexOf('firingRef.current = false'),
    'the firing lock must be released after the request, not after JPEG encoding',
  );
  const screen = read('src/components/GroupKioskAttendance.tsx');
  assert.match(screen, /if \(submitInFlight\.current\) return/);
});

test('the group screen names everybody rather than counting them', () => {
  // Six people told only "4 recorded" have no way to know which two of them
  // still need to try again.
  const screen = read('src/components/GroupKioskAttendance.tsx');
  assert.match(screen, /result\.people\.map\(/);
  assert.match(screen, /'\/api\/v2\/attendance\/auto\/group'/);
});

test('the front camera is the default on the group screen too', () => {
  const screen = read('src/components/GroupKioskAttendance.tsx');
  assert.match(screen, /useState<'user' \| 'environment'>\('user'\)/);
});

test('the two screens are never mounted at once', () => {
  // They would fight over the camera, and both would hold a stream. The toggle
  // swaps which is rendered rather than hiding one behind the other.
  const screen = read('src/components/AttendanceScreen.tsx');
  assert.match(screen, /mode === 'single' \? \(/);
  assert.ok(!screen.includes('hidden={'), 'the unchosen screen must not be merely hidden');
});

test('both cameras draw the boxes outside the mirroring transform', () => {
  // The preview is flipped with a CSS transform for the front camera, which is
  // now the default everywhere. An overlay nested inside that transform would
  // have every box mirrored a second time and land on the opposite side of the
  // screen from the face — so the flip is applied to the coordinates instead,
  // and the overlay is a sibling of the video.
  for (const path of ['src/components/CameraCapture.tsx', 'src/components/GroupCameraCapture.tsx']) {
    const camera = read(path);
    assert.match(camera, /mirrored: facing === 'user'/, `${path} does not mirror its boxes`);
    const video = camera.indexOf('<video');
    const overlay = camera.indexOf('<FaceBoxOverlay');
    assert.ok(overlay > video, `${path} must draw the overlay after the video, not inside it`);
  }
});

test('the boxes follow the live reading, not the stabilised one', () => {
  // The verdict is held steady so the guidance does not flicker. A box held the
  // same way would visibly lag the face it belongs to, and unlike the verdict,
  // a box briefly in the wrong place costs nothing.
  const single = read('src/components/CameraCapture.tsx');
  assert.match(single, /setFaceBoxes\(reading\.boxes \?\? \[\]\)/);
  assert.ok(!single.includes('setFaceBoxes(stableReading'), 'boxes must not be stabilised');

  const group = read('src/components/GroupCameraCapture.tsx');
  assert.match(group, /setFaceBoxes\(next\.boxes \?\? \[\]\)/);
  assert.ok(!group.includes('setFaceBoxes(stable.'), 'boxes must not be stabilised');
});

test('the single camera still draws exactly one box', () => {
  // It photographs one person. Boxing a passer-by in the background would
  // suggest the tablet was about to record them.
  const detector = read('src/lib/fullBodyDetector.ts');
  assert.match(detector, /limit: 1,/);
});

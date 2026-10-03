import type { Keypoint } from './fullBodyDetector.ts';

export interface CapturePosture {
  ready: boolean;
  guidance: string | null;
}

export const POSTURE_HOLD_MS = 1_000;

export function assessCapturePosture(points: Keypoint[], frameHeight?: number, frameWidth?: number): CapturePosture {
  const find = (name: string) => points.find((point) => point.name === name
    && (point.score ?? 0) >= 0.35 && Number.isFinite(point.x) && Number.isFinite(point.y)
    && (point.x as number) >= 0 && (point.y as number) >= 0
    && (!frameWidth || (point.x as number) < frameWidth)
    && (!frameHeight || (point.y as number) < frameHeight));
  const refuse = (guidance: string): CapturePosture => ({ ready: false, guidance });
  const leftShoulder = find('left_shoulder');
  const rightShoulder = find('right_shoulder');
  const leftHip = find('left_hip');
  const rightHip = find('right_hip');
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return refuse('Stand straight and face the camera');
  }
  const shoulderY = ((leftShoulder.y as number) + (rightShoulder.y as number)) / 2;
  const hipY = ((leftHip.y as number) + (rightHip.y as number)) / 2;
  const torso = hipY - shoulderY;
  const shoulderX = ((leftShoulder.x as number) + (rightShoulder.x as number)) / 2;
  const hipX = ((leftHip.x as number) + (rightHip.x as number)) / 2;
  const shoulderWidth = Math.abs((leftShoulder.x as number) - (rightShoulder.x as number));
  if (torso <= 0 || shoulderWidth <= 0
    || Math.abs((leftShoulder.y as number) - (rightShoulder.y as number)) > torso * 0.18
    || Math.abs(shoulderX - hipX) > torso * 0.2) {
    return refuse('Stand straight and face the camera');
  }
  for (const [side, shoulder, hip] of [
    ['left', leftShoulder, leftHip], ['right', rightShoulder, rightHip],
  ] as const) {
    const elbow = find(`${side}_elbow`);
    const wrist = find(`${side}_wrist`);
    if (!elbow || !wrist) return refuse('Keep both arms and hands visible');
    if ((elbow.y as number) < shoulderY + torso * 0.1
      || (wrist.y as number) < hipY - torso * 0.15) {
      return refuse('Lower your hands and relax your arms at your sides');
    }
    const outward = Math.sign((shoulder.x as number) - shoulderX);
    if (((wrist.x as number) - hipX) * outward < shoulderWidth * 0.15
      || Math.abs((wrist.x as number) - (hip.x as number)) > torso * 0.3
      || Math.abs((elbow.x as number) - (shoulder.x as number)) > torso * 0.45) {
      return refuse('Keep your arms relaxed at your sides');
    }
  }
  return { ready: true, guidance: null };
}

export function postureHoldStart(ready: boolean, previous: number | null, now: number): number | null {
  return ready ? previous ?? now : null;
}

export function postureHoldComplete(start: number | null, now: number): boolean {
  return start !== null && now - start >= POSTURE_HOLD_MS;
}

/**
 * Stands in for @mediapipe/pose, which pose-detection imports for its BlazePose
 * runtime. Only MoveNet is used here, so the real package is dead weight — and
 * its bundle is not valid ESM, which fails the build outright rather than
 * merely bloating it.
 */
export class Pose {
  constructor() {
    throw new Error('BlazePose is not bundled; MoveNet is the detector in use.');
  }
}
export const POSE_CONNECTIONS = [];
export const VERSION = 'stub';
export default { Pose, POSE_CONNECTIONS, VERSION };

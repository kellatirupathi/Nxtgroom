// The face-detection package can also run on MediaPipe's own runtime; the form
// uses its TensorFlow.js runtime only, so MediaPipe is not bundled.
export class FaceDetection {
  constructor() {
    throw new Error('The MediaPipe runtime is not bundled; the TensorFlow.js face detector is used.');
  }
}
export const VERSION = 'stub';
export default { FaceDetection, VERSION };

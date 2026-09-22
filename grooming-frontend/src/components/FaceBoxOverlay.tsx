import type { FaceBox } from '../lib/faceBoxes';

interface FaceBoxOverlayProps {
  boxes: FaceBox[];
  /**
   * True once the frame is one the camera would fire on. Only then do the boxes
   * turn green, so the colour means "this frame is good" rather than "a face is
   * here" — which the box itself already says.
   */
  ready?: boolean;
  /**
   * Shown under a box whose face is too turned away to identify. Left out by
   * the single-person camera, where the guidance line below the preview already
   * says the same thing and saying it twice is noise.
   */
  labelHidden?: string;
}

/**
 * Draws a box on each face the camera has found.
 *
 * Positioned in percentages over the preview, and deliberately a sibling of the
 * video rather than a child of it: the front-camera preview is flipped with a
 * CSS transform, and an overlay inside that flip would have its boxes mirrored
 * too — every one of them landing on the opposite side of the screen from the
 * face it belongs to. The mirroring is applied to the coordinates instead.
 *
 * Purely decorative to the machine, and marked as such. A screen reader
 * announcing six rectangles would bury the one line that actually tells
 * somebody what to do.
 */
export default function FaceBoxOverlay({ boxes, ready = false, labelHidden }: FaceBoxOverlayProps) {
  if (!boxes.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {boxes.map((box) => (
        <div
          key={box.key}
          /**
           * The transition is what makes this watchable. The detector reports
           * five times a second, and boxes snapping between those readings look
           * broken; a fifth of a second of linear movement covers exactly the
           * gap between two readings, so a moving face looks continuous.
           */
          className={`absolute rounded-lg border-2 transition-[left,top,width,height] duration-200 ease-linear ${
            !box.confident
              ? 'border-amber-400/90'
              : ready
                ? 'border-emerald-400'
                : 'border-white/80'
          }`}
          style={{
            left: `${box.left * 100}%`,
            top: `${box.top * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`,
          }}
        >
          {/* Which of them needs to turn around, on the person it is about.
              A group of six told "2 people are not facing the camera" has no
              way to work out which two without this. */}
          {labelHidden && !box.confident && (
            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {labelHidden}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

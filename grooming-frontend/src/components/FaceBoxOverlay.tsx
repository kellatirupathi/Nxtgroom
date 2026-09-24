import type { FaceBox } from '../lib/faceBoxes';

interface FaceBoxOverlayProps {
  boxes: FaceBox[];
}

/**
 * Draws a box on each face the camera has found.
 *
 * Green means the camera can see a face it could identify somebody from. Amber
 * means it cannot — the person is turned away — and a chip under the box says
 * what to do about it. A chip can also sit under a green box, when the face is
 * fine and the body is not: "Step back" on somebody whose feet are out of
 * frame. The box answers "am I detected?"; the chip answers "what do I fix?".
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
export default function FaceBoxOverlay({ boxes }: FaceBoxOverlayProps) {
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
          className={`absolute rounded-lg border-[3px] transition-[left,top,width,height] duration-200 ease-linear ${
            box.confident ? 'border-emerald-400' : 'border-amber-400'
          }`}
          style={{
            left: `${box.left * 100}%`,
            top: `${box.top * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`,
          }}
        >
          {box.label && (
            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-white shadow">
              {box.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

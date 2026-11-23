import type { FaceBox } from '../lib/faceBoxes';
import type { QuarterTurn } from '../lib/frameTurn';

interface FaceBoxOverlayProps {
  boxes: FaceBox[];
  labelTurn?: QuarterTurn;
}

// Where a box's chip hangs: below the face as the people in front of the
// camera see it. On a tablet whose screen did not turn with it, "below" is a
// different edge of the box, and the chip is turned to read upright there.
const CHIP_ANCHOR: Record<QuarterTurn, { left: string; top: string }> = {
  0: { left: '50%', top: '100%' },
  90: { left: '0%', top: '50%' },
  180: { left: '50%', top: '0%' },
  270: { left: '100%', top: '50%' },
};

export default function FaceBoxOverlay({ boxes, labelTurn = 0 }: FaceBoxOverlayProps) {
  if (!boxes.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {boxes.map((box) => (
        <div
          key={box.key}
          className={`absolute rounded-lg border-[3px] transition-[left,top,width,height] duration-100 ease-linear ${
            box.confident ? 'border-emerald-400' : 'border-amber-400'
          }`}
          style={{
            left: `${box.left * 100}%`,
            top: `${box.top * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`,
          }}
        >
          {box.label && (labelTurn === 0 ? (
            <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-white shadow">
              {box.label}
            </span>
          ) : (
            <span className="absolute h-0 w-0" style={CHIP_ANCHOR[labelTurn]}>
              <span
                className="absolute left-0 top-0 whitespace-nowrap rounded bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-white shadow"
                style={{ transform: `translate(-50%, -50%) rotate(${labelTurn}deg) translateY(calc(50% + 6px))` }}
              >
                {box.label}
              </span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

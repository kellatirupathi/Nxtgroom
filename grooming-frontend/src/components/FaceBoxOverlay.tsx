import type { FaceBox } from '../lib/faceBoxes';

interface FaceBoxOverlayProps {
  boxes: FaceBox[];
}

export default function FaceBoxOverlay({ boxes }: FaceBoxOverlayProps) {
  if (!boxes.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {boxes.map((box) => (
        <div
          key={box.key}
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

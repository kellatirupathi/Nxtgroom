import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { QuarterTurn } from '../lib/frameTurn';

interface TurnedLayerProps {
  turn: QuarterTurn;
  className?: string;
  children: ReactNode;
}

// Fills its positioned parent, turned clockwise by `turn`, so messages read
// upright for the people in front of a tablet whose screen did not rotate
// with it (see lib/frameTurn.ts). Turned a quarter, the layer swaps its width
// and height so it still covers the parent exactly. Turn 0 is a plain layer.
export default function TurnedLayer({ turn, className = '', children }: TurnedLayerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent || turn === 0) return undefined;
    const measure = () => setSize({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [turn]);

  if (turn === 0 || !size) {
    return <div ref={ref} className={`absolute inset-0 ${className}`}>{children}</div>;
  }
  const sideways = turn === 90 || turn === 270;
  return (
    <div
      ref={ref}
      className={`absolute ${className}`}
      style={{
        left: '50%',
        top: '50%',
        width: sideways ? size.height : size.width,
        height: sideways ? size.width : size.height,
        transform: `translate(-50%, -50%) rotate(${turn}deg)`,
      }}
    >
      {children}
    </div>
  );
}

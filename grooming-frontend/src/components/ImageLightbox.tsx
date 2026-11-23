import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';

export interface LightboxImage {
  url: string | null;
  label?: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  startIndex?: number;
  title: string;
  onClose: () => void;
}

// One photo at a time over the page, with previous / next for several.
export default function ImageLightbox({ images, startIndex = 0, title, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, images.length - 1)));
  const [failed, setFailed] = useState(false);
  const count = images.length;
  const current = images[index];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && count > 1) {
        setFailed(false);
        setIndex((value) => (value + 1) % count);
      }
      if (event.key === 'ArrowLeft' && count > 1) {
        setFailed(false);
        setIndex((value) => (value - 1 + count) % count);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [count, onClose]);

  const step = (delta: number) => {
    setFailed(false);
    setIndex((value) => (value + delta + count) % count);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/80 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="relative flex max-h-full w-full max-w-4xl flex-col items-center" onClick={(event) => event.stopPropagation()}>
        <div className="mb-2 flex w-full items-center justify-between gap-3 text-white">
          <p className="min-w-0 truncate text-sm font-semibold">
            {title}
            {count > 1 && <span className="ml-2 font-normal text-white/70">{index + 1} / {count}</span>}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close photo"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="relative flex w-full items-center justify-center">
          {current?.url && !failed ? (
            <img
              src={current.url}
              alt={current.label || title}
              onError={() => setFailed(true)}
              className="max-h-[78dvh] w-auto max-w-full rounded-md bg-white object-contain"
            />
          ) : (
            <div className="flex h-64 w-full max-w-md flex-col items-center justify-center gap-2 rounded-md bg-white/10 text-center text-sm text-white/80">
              <ImageOff size={28} aria-hidden="true" />
              This photo could not be loaded. Close and open it again.
            </div>
          )}
          {count > 1 && (
            <>
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="Previous photo"
                className="absolute left-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-slate-900/60 text-white hover:bg-slate-900/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:-left-12"
              >
                <ChevronLeft size={22} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="Next photo"
                className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-slate-900/60 text-white hover:bg-slate-900/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:-right-12"
              >
                <ChevronRight size={22} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

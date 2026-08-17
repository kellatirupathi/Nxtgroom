import { useEffect, useState } from 'react';
import { ImageOff, Loader2, X } from 'lucide-react';
import { apiFetch } from '../api';

interface PhotoViewerProps {
  attendanceId: string;
  kind: 'checkin' | 'checkout';
  /** Shown in the header so it is clear whose photo this is. */
  title: string;
  subtitle?: string;
  onClose: () => void;
}

/**
 * Displays a stored attendance photo.
 *
 * The bucket is private, so the URL is minted per view and expires. It is
 * fetched when the dialog opens rather than embedded in the table, which
 * keeps signed links out of any list payload that might be cached or logged.
 */
export default function PhotoViewer({ attendanceId, kind, title, subtitle, onClose }: PhotoViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    apiFetch<{ url: string }>(
      `/api/v2/attendance/${encodeURIComponent(attendanceId)}/photo/${kind}`,
    )
      .then((data) => {
        if (disposed) return;
        setUrl(data.url);
      })
      .catch((requestError) => {
        if (disposed) return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [attendanceId, kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-viewer-title"
    >
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-md bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="min-w-0">
            <h2 id="photo-viewer-title" className="truncate text-sm font-bold text-slate-800">
              {title}
            </h2>
            <p className="text-xs font-medium text-slate-500">
              {kind === 'checkin' ? 'Check-in photo' : 'Check-out photo'}
              {subtitle ? ` · ${subtitle}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close photo"
            className="-m-1 shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex min-h-[280px] items-center justify-center bg-slate-900/5 p-4">
          {loading && (
            <span className="flex items-center gap-2 text-sm font-medium text-slate-500" role="status">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Loading photo…
            </span>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-2 text-center">
              <ImageOff size={28} className="text-slate-300" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-600">{error}</p>
            </div>
          )}

          {!loading && !error && url && (
            <img
              src={url}
              alt={`${kind === 'checkin' ? 'Check-in' : 'Check-out'} photo for ${title}`}
              className="max-h-[60vh] w-auto rounded-md object-contain"
            />
          )}
        </div>

        <p className="border-t border-slate-100 px-4 py-2 text-center text-[11px] text-slate-400">
          This link is temporary and expires shortly.
        </p>
      </div>
    </div>
  );
}

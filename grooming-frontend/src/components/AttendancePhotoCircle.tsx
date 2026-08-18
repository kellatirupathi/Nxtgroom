import { useEffect, useState } from 'react';
import { Expand, ImageOff, User } from 'lucide-react';
import { apiFetch } from '../api';

interface AttendancePhotoCircleProps {
  attendanceId: string;
  kind: 'checkin' | 'checkout';
  /** Absent when no photo was stored for this half of the record. */
  hasPhoto: boolean;
  label: string;
  onOpen: () => void;
}

/**
 * The stored photo, shown where the avatar used to be.
 *
 * The record already has a picture of the person taken that day, so a generic
 * silhouette in its place was a placeholder standing in front of the real
 * thing. The bucket is private, so the URL is minted per view and expires;
 * fetching it here rather than embedding it in the list keeps signed links out
 * of any payload that might be cached.
 */
export default function AttendancePhotoCircle({
  attendanceId,
  kind,
  hasPhoto,
  label,
  onOpen,
}: AttendancePhotoCircleProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasPhoto) {
      setUrl(null);
      return undefined;
    }
    let disposed = false;
    setUrl(null);
    setFailed(false);
    apiFetch<{ url: string }>(`/api/v2/attendance/${encodeURIComponent(attendanceId)}/photo/${kind}`)
      .then((data) => {
        if (!disposed) setUrl(data.url);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => { disposed = true; };
  }, [attendanceId, kind, hasPhoto]);

  const frame = 'w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden flex items-center justify-center shrink-0';

  if (!hasPhoto || failed) {
    return (
      <div className={`${frame} bg-slate-100 text-slate-300 border border-slate-200`}>
        {failed ? <ImageOff size={36} aria-hidden="true" /> : <User size={44} aria-hidden="true" />}
        <span className="sr-only">
          {failed ? 'The photo could not be loaded' : `No ${label.toLowerCase()} photo was stored`}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View the ${label.toLowerCase()} photo full size`}
      title={`View the ${label.toLowerCase()} photo`}
      className={`${frame} group relative border-2 border-indigo-100 bg-indigo-50 transition-colors hover:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2`}
    >
      {url ? (
        <>
          {/* object-top: a check-in photo is full-body, and centring it crops
              the face, which is the part worth seeing at this size. */}
          <img src={url} alt="" className="h-full w-full object-cover object-top" />
          <span className="absolute inset-0 flex items-center justify-center bg-slate-900/0 text-white opacity-0 transition-all group-hover:bg-slate-900/40 group-hover:opacity-100">
            <Expand size={22} aria-hidden="true" />
          </span>
        </>
      ) : (
        <span className="h-full w-full animate-pulse bg-slate-200" role="status" aria-label="Loading photo" />
      )}
    </button>
  );
}

import { ExternalLink, MapPin } from 'lucide-react';

interface LocationPanelProps {
  coordinates?: string | null;
  address?: string | null;
  accuracyMetres?: number | null;
}

/**
 * Shows where a check-in happened: the address, the raw coordinates, and a
 * map centred on them.
 *
 * The map is OpenStreetMap's embed, which needs no API key or billing account.
 * It is an iframe rather than a mapping library so the bundle gains nothing,
 * and it renders from the stored coordinates, so it keeps working without a
 * further lookup.
 */
export default function LocationPanel({ coordinates, address, accuracyMetres }: LocationPanelProps) {
  if (!coordinates) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-slate-400">
        <MapPin size={14} aria-hidden="true" /> No location was recorded for this check-in.
      </p>
    );
  }

  const [latitude, longitude] = coordinates.split(',').map((value) => Number(value.trim()));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return <p className="text-sm text-slate-400">{coordinates}</p>;
  }

  // A small box around the point; the marker is what actually locates it.
  const span = 0.004;
  const bbox = [longitude - span, latitude - span / 2, longitude + span, latitude + span / 2].join('%2C');
  const embedUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude}%2C${longitude}`;
  const linkUrl = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;

  const accuracy = typeof accuracyMetres === 'number' && accuracyMetres > 0
    ? accuracyMetres < 1000
      ? `±${accuracyMetres} m`
      : `±${(accuracyMetres / 1000).toFixed(1)} km`
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5">
        <MapPin size={14} className="mt-0.5 shrink-0 text-indigo-600" aria-hidden="true" />
        <div className="min-w-0">
          {address ? (
            <p className="text-sm font-semibold text-slate-700">{address}</p>
          ) : (
            <p className="text-sm text-slate-400">Address unavailable</p>
          )}
          <p className="text-xs font-mono text-slate-500">
            {latitude.toFixed(6)}, {longitude.toFixed(6)}
            {/* Shown next to the reading so a coarse fix is never mistaken
                for a precise one. */}
            {accuracy && <span className="ml-2 font-sans text-slate-400">{accuracy}</span>}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-slate-200">
        <iframe
          title="Check-in location map"
          src={embedUrl}
          className="h-48 w-full"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </div>

      <a
        href={linkUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 hover:underline"
      >
        Open larger map <ExternalLink size={12} aria-hidden="true" />
      </a>
    </div>
  );
}

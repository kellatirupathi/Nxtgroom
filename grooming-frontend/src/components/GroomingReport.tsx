import { useEffect, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { apiFetch } from '../api';
import {
  evidenceCrop,
  hasEvidenceBoxes,
  improvementTipsFor,
  isUnassessed,
  REPORT_COLUMNS,
  reportTables,
  validEvidenceBox,
} from '../reportLayout';
import type { CheckItem, Evaluation } from '../types';

/** Where the report's photograph comes from: its endpoint, and whether it needs a sign-in. */
export interface ReportPhoto {
  path: string;
  auth?: boolean;
}

/** Kept beside REPORT_COLUMNS so a column can never lose its width. */
const COLUMN_WIDTHS = ['w-[23%]', 'w-[10%]', 'w-[31%]', 'w-[36%]'];

interface ReportRow {
  key: string;
  name?: string;
  observation?: unknown;
  status?: string;
  reasoning?: string;
  evidenceBox?: [number, number, number, number];
  evidenceLabel?: string;
}

/**
 * The area a close-up check read, cut from the photograph and shown at the
 * size of a thumbnail, so whoever reads the report sees what was judged.
 */
function EvidenceCrop({ url, box, label }: { url: string; box: [number, number, number, number]; label?: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const crop = evidenceCrop(box, size?.width, size?.height);
  // At most 160px wide and about 150px high, so a tall crop (the trousers)
  // does not stretch its row.
  const width = Math.max(64, Math.min(160, Math.round(150 * crop.ratio)));
  return (
    <figure className="mt-2" style={{ width }}>
      <a href={url} target="_blank" rel="noopener noreferrer" title="Open the full photograph" className="block">
        <div className="relative w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100" style={{ aspectRatio: crop.aspectRatio }}>
          <img
            src={url}
            alt={label || 'Close-up from the photograph'}
            loading="lazy"
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            className="absolute max-w-none"
            style={{ width: crop.width, height: crop.height, left: crop.left, top: crop.top }}
          />
        </div>
      </a>
      {label && <figcaption className="mt-1 text-[11px] font-semibold text-slate-500">{label}</figcaption>}
    </figure>
  );
}

export function CheckStatus({ status }: { status?: string }) {
  if (!status) return null;
  const normalized = String(status).toUpperCase();
  const style = normalized === 'PASS'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : normalized === 'FAIL'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-slate-50 text-slate-600 border-slate-200';
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${style}`}>{normalized}</span>;
}

export function ReportSection({ title, items, photoUrl }: { title: string; items?: CheckItem[] | Record<string, unknown> | null; photoUrl?: string | null }) {
  if (!items || (Array.isArray(items) && items.length === 0)) return null;
  const rows: ReportRow[] = Array.isArray(items)
    ? items.map((item, index) => ({
      key: `${item.code || item.checkpoint_name || 'checkpoint'}-${index}`,
      name: item.checkpoint_name,
      observation: item.observation,
      status: item.status,
      reasoning: item.reason || (item as CheckItem & { reasoning?: string }).reasoning,
      evidenceBox: validEvidenceBox(item.evidence_box) ? item.evidence_box : undefined,
      evidenceLabel: item.evidence_label,
    }))
    : Object.entries(items as Record<string, unknown>).map(([name, observation]) => ({ key: name, name, observation }));

  const anchor = `report-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  return (
    <section className="mb-6" aria-labelledby={anchor}>
      <h4 id={anchor} className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 border-b border-slate-100 pb-2">{title}</h4>
      {/* Phones: each checkpoint stacked - name and result, then what was
          seen and why - since four columns do not fit and the reason column
          ended up off-screen. Wider screens keep the table. */}
      <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white shadow-sm md:hidden">
        {rows.map((item) => (
          <li key={item.key} className="p-3.5">
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-bold text-slate-700">{item.name}</span>
              <span className="shrink-0"><CheckStatus status={item.status} /></span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{String(item.observation ?? '--')}</p>
            {item.reasoning && <p className="mt-1 text-xs leading-snug text-slate-500">{item.reasoning}</p>}
            {photoUrl && item.evidenceBox && <EvidenceCrop url={photoUrl} box={item.evidenceBox} label={item.evidenceLabel} />}
          </li>
        ))}
      </ul>
      <div className="hidden md:block bg-white rounded-md border border-slate-200 overflow-x-auto shadow-sm">
        <table className="w-full text-left text-sm min-w-[520px]">
          <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500">
            <tr>
              {REPORT_COLUMNS.map((column, index) => (
                <th key={column} scope="col" className={`p-3 ${COLUMN_WIDTHS[index]}`}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((item) => (
              <tr key={item.key} className="hover:bg-slate-50 transition-colors">
                <td className="p-3 font-bold text-slate-700">{item.name}</td>
                <td className="p-3"><CheckStatus status={item.status} /></td>
                <td className="p-3 text-slate-600">{String(item.observation ?? '--')}</td>
                <td className="p-3 text-slate-500">
                  {item.reasoning || '--'}
                  {photoUrl && item.evidenceBox && <EvidenceCrop url={photoUrl} box={item.evidenceBox} label={item.evidenceLabel} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * What the instructor should change.
 *
 * The list is derived from the failing checkpoints by the backend, so the
 * report page and the emails cannot advise different things. Only FAIL
 * produces a tip: a passing checkpoint needs no action, and an N/A means the
 * camera could not see it, which is not something the instructor did.
 */
export function ImprovementTips({ evaluation }: { evaluation: Evaluation }) {
  const tips = improvementTipsFor(evaluation);

  return (
    <section aria-labelledby="report-improvement-tips" className="rounded-md border border-amber-200 bg-amber-50/60 p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-6">
        <h4 id="report-improvement-tips" className="flex items-center gap-2 text-sm font-bold text-amber-700 shrink-0">
          <Lightbulb size={18} aria-hidden="true" />
          Improvement Tips
        </h4>
        {tips.length === 0 ? (
          <p className="text-sm font-medium text-slate-500">None</p>
        ) : (
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-700">
            {tips.map((tip) => <li key={tip}>{tip}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * The five checkpoint tables that make up an appearance audit. Shared by the
 * public report page, the authenticated detail view and the post-check-in
 * modal, so the same evaluation cannot appear differently in different parts
 * of FacultyTrack.
 */
export default function GroomingReport({ evaluation, photo }: { evaluation: Evaluation; photo?: ReportPhoto | null }) {
  // The photograph is fetched only when a row has a close-up to show: a
  // signed link, so the crops load straight from storage.
  const wantsPhoto = Boolean(photo?.path) && hasEvidenceBoxes(evaluation);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!wantsPhoto || !photo?.path) return undefined;
    let active = true;
    apiFetch<{ url: string }>(photo.path, { auth: photo.auth ?? true })
      .then((data) => { if (active && data?.url) setPhotoUrl(data.url); })
      .catch(() => { /* The report reads the same without the thumbnails. */ });
    return () => { active = false; };
  }, [wantsPhoto, photo?.path, photo?.auth]);

  // An evaluation with no dress code applied has nothing to tabulate. Five
  // empty tables would imply the checks ran and found nothing.
  if (isUnassessed(evaluation)) {
    return (
      <div role="status" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800">
        {evaluation.unassessed_reason === 'NO_PERSON_VISIBLE'
          ? 'No appearance assessment was made, because the photograph does not show the instructor. Retake it as a clear, full-length photo of the person checking in.'
          : 'No appearance assessment was made, because this instructor has no gender recorded and the applicable dress code could not be determined. Set it under Instructors and the next check-in will be assessed normally.'}
      </div>
    );
  }

  return (
    <>
      {reportTables(evaluation).map((table) => (
        <ReportSection key={table.key} title={table.title} items={table.items} photoUrl={wantsPhoto ? photoUrl : null} />
      ))}
      <ImprovementTips evaluation={evaluation} />
    </>
  );
}

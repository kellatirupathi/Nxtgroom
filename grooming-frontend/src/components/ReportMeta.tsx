import { CreditCard, Eye, Footprints, Hand, Shirt, Sparkles, User } from 'lucide-react';
import type { Evaluation, Visibility, WeeklyRotation } from '../types';

/**
 * Image quality and human review, shown together because they answer the same
 * question: how much weight this report can carry on its own.
 */
export function ReportFlags({ evaluation }: { evaluation: Evaluation }) {
  const retake = evaluation.image_quality === 'RETAKE_RECOMMENDED';
  const review = Boolean(evaluation.requires_human_review);
  return (
    <div className="flex flex-wrap gap-2">
      <div className={`rounded-md border px-3 py-2 ${retake ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Image quality</p>
        <p className={`text-xs font-extrabold ${retake ? 'text-amber-700' : 'text-slate-700'}`}>
          {retake ? 'Retake recommended' : 'Adequate'}
        </p>
      </div>
      <div className={`rounded-md border px-3 py-2 ${review ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Human review</p>
        <p className={`text-xs font-extrabold ${review ? 'text-rose-700' : 'text-emerald-700'}`}>
          {review ? 'Required' : 'Not required'}
        </p>
      </div>
    </div>
  );
}

export function AiSummary({ summary }: { summary?: string }) {
  if (!summary) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-white p-4 sm:flex-row sm:items-start sm:gap-5">
      <p className="flex shrink-0 items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-indigo-600">
        <Sparkles size={15} aria-hidden="true" />
        AI summary
      </p>
      <p className="text-sm leading-relaxed text-slate-700">{summary}</p>
    </div>
  );
}

const REGIONS: Array<{ key: keyof NonNullable<Evaluation['visible_regions']>; label: string; Icon: typeof User }> = [
  { key: 'face', label: 'Face', Icon: User },
  { key: 'upper_body', label: 'Upper Body', Icon: Shirt },
  { key: 'lower_body', label: 'Lower Body', Icon: Shirt },
  { key: 'footwear', label: 'Footwear', Icon: Footprints },
  { key: 'id_card', label: 'ID Card', Icon: CreditCard },
  { key: 'hands', label: 'Hands', Icon: Hand },
];

function visibilityStyle(value: Visibility) {
  if (value === 'VISIBLE') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (value === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-400';
}

/**
 * What the camera actually captured.
 *
 * This is visibility metadata, not a score. It exists so an N/A row can be
 * traced to a part of the body the photograph did not show, rather than
 * reading as a checkpoint the system failed to run.
 */
export function VisibleRegions({ regions }: { regions?: Evaluation['visible_regions'] }) {
  if (!regions) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <p className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        <Eye size={15} aria-hidden="true" />
        Visible regions
      </p>
      <ul className="flex flex-wrap gap-2">
        {REGIONS.map(({ key, label, Icon }) => {
          const value = regions[key];
          return (
            <li
              key={key}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-bold ${visibilityStyle(value)}`}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
              {value === 'PARTIAL' && <span className="font-medium opacity-80">(partial)</span>}
              {value === 'NOT_VISIBLE' && <span className="font-medium opacity-80">(not shown)</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ROTATION_LABEL: Record<WeeklyRotation['status'], { text: string; className: string }> = {
  PASS: { text: 'Met', className: 'text-emerald-700' },
  FAIL: { text: 'Not met', className: 'text-rose-700' },
  IN_PROGRESS: { text: 'In progress', className: 'text-indigo-600' },
  INSUFFICIENT_DATA: { text: 'Insufficient data', className: 'text-slate-500' },
};

/**
 * The weekly saree and kurti split.
 *
 * Rendered only when the backend supplies it, which it does for women alone —
 * a man in formal wear every day is complying exactly, and showing him a
 * rotation he cannot satisfy would invent a violation.
 */
export function WeeklyRotationCard({ rotation }: { rotation?: WeeklyRotation | null }) {
  if (!rotation) return null;
  const label = ROTATION_LABEL[rotation.status];
  return (
    <section aria-labelledby="weekly-rotation" className="rounded-md border border-slate-200 bg-white p-4">
      <h3 id="weekly-rotation" className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        Weekly rotation
      </h3>
      <dl className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-600">Saree days</dt>
          <dd className="font-bold tabular-nums text-slate-800">{rotation.saree_days} / {rotation.required_saree_days}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-600">Kurti days</dt>
          <dd className="font-bold tabular-nums text-slate-800">{rotation.kurti_days} / {rotation.required_kurti_days}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-600">Unclassified days</dt>
          <dd className="font-bold tabular-nums text-slate-800">{rotation.unknown_days}</dd>
        </div>
      </dl>
      <div className="mt-3 flex items-center justify-between gap-4 border-t border-slate-100 pt-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Result</p>
        <p className={`text-sm font-extrabold ${label.className}`}>{label.text}</p>
      </div>
    </section>
  );
}

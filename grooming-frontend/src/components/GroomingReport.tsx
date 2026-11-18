import { Check, ChevronDown, Lightbulb, X } from 'lucide-react';
import { improvementTipsFor, isUnassessed, REPORT_COLUMNS, reportTables } from '../reportLayout';
import type { CheckItem, Evaluation } from '../types';

const COLUMN_WIDTHS = ['w-[23%]', 'w-[10%]', 'w-[31%]', 'w-[36%]'];

interface ReportRow {
  key: string;
  name?: string;
  observation?: unknown;
  status?: string;
  reasoning?: string;
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

export function ReportSection({ title, items }: { title: string; items?: CheckItem[] | Record<string, unknown> | null }) {
  if (!items || (Array.isArray(items) && items.length === 0)) return null;
  const rows: ReportRow[] = Array.isArray(items)
    ? items.map((item, index) => ({
      key: `${item.code || item.checkpoint_name || 'checkpoint'}-${index}`,
      name: item.checkpoint_name,
      observation: item.observation,
      status: item.status,
      reasoning: item.reason || (item as CheckItem & { reasoning?: string }).reasoning,
    }))
    : Object.entries(items as Record<string, unknown>).map(([name, observation]) => ({ key: name, name, observation }));

  const anchor = `report-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const scored = rows.filter((item) => ['PASS', 'FAIL'].includes(String(item.status).toUpperCase()));
  const passed = scored.filter((item) => String(item.status).toUpperCase() === 'PASS').length;
  const failed = scored.length - passed;
  const shortTitle = title.replace(/^\d+\.\s*/, '').replace(/\s+Check\b/, '');
  return (
    <section className="mb-2.5 md:mb-6" aria-labelledby={anchor}>
      <h4 id={anchor} className="max-md:sr-only text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 border-b border-slate-100 pb-2">{title}</h4>
      <details className="group overflow-hidden rounded-xl border border-slate-200 bg-white md:hidden" open={failed > 0}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2.5 px-3.5 py-3 text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full ${failed > 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}
          >
            {failed > 0 ? <X size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}
          </span>
          <span className="flex-1">{shortTitle}</span>
          {scored.length > 0 && (
            <span className={`text-[13px] font-semibold tabular-nums ${failed > 0 ? 'text-rose-700' : 'text-slate-500'}`}>
              {passed} / {scored.length}
            </span>
          )}
          <ChevronDown size={16} className="text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
      <ul className="divide-y divide-slate-100 border-t border-slate-100 bg-white md:hidden">
        {rows.map((item) => (
          <li key={item.key} className={`p-3.5 ${String(item.status).toUpperCase() === 'FAIL' ? 'bg-rose-50/40' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-bold text-slate-700">{item.name}</span>
              <span className="shrink-0"><CheckStatus status={item.status} /></span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{String(item.observation ?? '--')}</p>
            {item.reasoning && <p className="mt-1 text-xs leading-snug text-slate-500">{item.reasoning}</p>}
          </li>
        ))}
      </ul>
      </details>
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
                <td className="p-3 text-slate-500">{item.reasoning || '--'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ImprovementTips({ evaluation, largeScreensOnly = false }: { evaluation: Evaluation; largeScreensOnly?: boolean }) {
  const tips = improvementTipsFor(evaluation);

  return (
    <section aria-labelledby="report-improvement-tips" className={`rounded-md border border-amber-200 bg-amber-50/60 p-4 sm:p-5 ${largeScreensOnly ? 'hidden lg:block' : ''}`}>
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

export default function GroomingReport({ evaluation, tipsShownSeparately = false }: { evaluation: Evaluation; tipsShownSeparately?: boolean }) {
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
        <ReportSection key={table.key} title={table.title} items={table.items} />
      ))}
      <ImprovementTips evaluation={evaluation} largeScreensOnly={tipsShownSeparately} />
    </>
  );
}

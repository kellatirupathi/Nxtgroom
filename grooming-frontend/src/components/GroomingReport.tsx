import type { CheckItem, Evaluation } from '../types';

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
      key: `${item.checkpoint_name || 'checkpoint'}-${index}`,
      name: item.checkpoint_name,
      observation: item.observation,
      status: item.status,
      reasoning: item.reason || (item as CheckItem & { reasoning?: string }).reasoning,
    }))
    : Object.entries(items as Record<string, unknown>).map(([name, observation]) => ({ key: name, name, observation }));

  const anchor = `report-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <section className="mb-6" aria-labelledby={anchor}>
      <h4 id={anchor} className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 border-b border-slate-100 pb-2">{title}</h4>
      <div className="bg-white rounded-md border border-slate-200 overflow-x-auto shadow-sm">
        <table className="w-full text-left text-sm min-w-[520px]">
          <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500">
            <tr><th className="p-3">Checkpoint</th><th className="p-3">Result</th><th className="p-3">Observation</th><th className="p-3">Evidence</th></tr>
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

/**
 * The five checkpoint tables that make up a grooming audit. Shared by the
 * full detail page and the post-check-in modal so the two cannot drift into
 * showing the same evaluation differently.
 */
export default function GroomingReport({ evaluation }: { evaluation: Evaluation }) {
  return (
    <>
      <ReportSection title="General ID Card Check" items={evaluation.general_idcard_check} />
      <ReportSection title="Grooming Check" items={evaluation.grooming_check} />
      <ReportSection title="Attire Check" items={evaluation.attire_check} />
      <ReportSection title="Accessories Check" items={evaluation.accessories_check} />
      <ReportSection title="Footwear Check" items={evaluation.footwear_check} />
    </>
  );
}

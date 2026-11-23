import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, Loader2, X } from 'lucide-react';
import { apiJson } from '../api';
import { saveCsvFile } from '../attendanceExport';
import {
  IMPORT_TEMPLATE_HEADERS,
  importRowsFromCsv,
  importTemplateCsv,
  type FormImportRow,
} from '../lib/instituteForm';

interface ImportResult {
  created: number;
  skipped: { row: number; reason: string }[];
}

interface FormResponsesImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

// Rows go to the server in batches that stay well under its 1 MB request limit.
const CHUNK_ROWS = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export default function FormResponsesImportDialog({ open, onClose, onImported }: FormResponsesImportDialogProps) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<FormImportRow[]>([]);
  const [parseError, setParseError] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    setFileName('');
    setRows([]);
    setParseError('');
    setImporting(false);
    setProgress(0);
    setResult(null);
    setError('');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const chooseFile = async (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setResult(null);
    setError('');
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setRows([]);
      setParseError('The file is larger than 5 MB. Split it into smaller files.');
      return;
    }
    const parsed = importRowsFromCsv(await file.text());
    setRows(parsed.rows);
    setParseError(parsed.error || (parsed.rows.length ? '' : 'The file has no rows to import.'));
  };

  const runImport = async () => {
    if (!rows.length || importing) return;
    setImporting(true);
    setError('');
    setProgress(0);
    const total: ImportResult = { created: 0, skipped: [] };
    try {
      for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
        const chunk = rows.slice(start, start + CHUNK_ROWS);
        const part = await apiJson<ImportResult>('/api/v2/form-responses/import', {
          method: 'POST',
          body: { rows: chunk },
          timeoutMs: 120_000,
        });
        total.created += part.created;
        total.skipped.push(...part.skipped);
        setProgress(Math.min(rows.length, start + chunk.length));
      }
      setResult(total);
      if (total.created) onImported();
    } catch (requestError) {
      setResult(total.created || total.skipped.length ? total : null);
      if (total.created) onImported();
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="form-import-title">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:rounded-lg">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <h2 id="form-import-title" className="flex items-center gap-2 text-base font-bold text-slate-800">
            <FileUp size={18} className="text-indigo-600" aria-hidden="true" />
            Import form responses
          </h2>
          <button type="button" onClick={onClose} disabled={importing} aria-label="Close" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm text-slate-600">
          <p>
            Upload a CSV file of existing responses, for example the Google Form's response sheet downloaded as CSV
            (File, Download, Comma-separated values). Imported rows are marked <b>Manual</b>.
          </p>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="font-semibold text-slate-700">Columns</p>
            <p className="mt-1 break-words text-xs text-slate-600">{IMPORT_TEMPLATE_HEADERS.join(' · ')}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
              <li>Date, Photo Submission Status, University Name and Submitted By are required. Timestamp is optional.</li>
              <li>Dates are read day first: 23-11-2026, 23/11/2026 or 2026-11-23. Future dates are skipped.</li>
              <li>University Name must match an institute's name exactly (capitals do not matter).</li>
              <li>Grooming Picture can hold up to 5 picture links separated by commas; they are kept as links.</li>
              <li>A day that already has a response for that institute is skipped, never overwritten.</li>
            </ul>
            <button
              type="button"
              onClick={() => { void saveCsvFile('form-responses-template.csv', importTemplateCsv()); }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              <Download size={14} aria-hidden="true" />
              Download template
            </button>
          </div>

          <div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => { void chooseFile(event.target.files?.[0]); }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={importing}
              className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-300 px-4 py-6 text-center hover:border-indigo-400 hover:bg-indigo-50/40 disabled:opacity-60"
            >
              <FileUp size={22} className="text-indigo-600" aria-hidden="true" />
              <span className="font-semibold text-slate-700">{fileName || 'Choose a CSV file'}</span>
              <span className="text-xs text-slate-500">{fileName ? 'Click to choose a different file' : 'Up to 5 MB'}</span>
            </button>
          </div>

          {parseError && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-700">{parseError}</p>}

          {!parseError && rows.length > 0 && !result && (
            <div>
              <p className="font-semibold text-slate-700">{rows.length} row{rows.length === 1 ? '' : 's'} ready to import</p>
              <div className="mt-2 overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Row</th>
                      <th className="px-2 py-1.5 font-semibold">Date</th>
                      <th className="px-2 py-1.5 font-semibold">Status</th>
                      <th className="px-2 py-1.5 font-semibold">University</th>
                      <th className="px-2 py-1.5 font-semibold">Submitted By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((row) => (
                      <tr key={row.row} className="border-t border-slate-100">
                        <td className="px-2 py-1.5">{row.row}</td>
                        <td className="px-2 py-1.5">{row.date}</td>
                        <td className="px-2 py-1.5">{row.status}</td>
                        <td className="max-w-[12rem] truncate px-2 py-1.5" title={row.university}>{row.university}</td>
                        <td className="max-w-[10rem] truncate px-2 py-1.5" title={row.submitted_by}>{row.submitted_by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 5 && <p className="mt-1 text-xs text-slate-500">Showing the first 5 rows.</p>}
            </div>
          )}

          {importing && (
            <p className="flex items-center gap-2 font-medium text-slate-700" role="status">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Importing… {progress} of {rows.length}
            </p>
          )}

          {error && <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-700">{error}</p>}

          {result && (
            <div className="space-y-2" role="status">
              <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 font-semibold text-emerald-800">
                {result.created} response{result.created === 1 ? '' : 's'} imported
                {result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.
              </p>
              {result.skipped.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded-md border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-2 py-1.5 font-semibold">Row</th>
                        <th className="px-2 py-1.5 font-semibold">Why it was skipped</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.skipped.map((skip) => (
                        <tr key={`${skip.row}-${skip.reason}`} className="border-t border-slate-100">
                          <td className="px-2 py-1.5 align-top">{skip.row}</td>
                          <td className="px-2 py-1.5">{skip.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button type="button" onClick={onClose} disabled={importing} className="h-10 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              type="button"
              onClick={() => { void runImport(); }}
              disabled={!rows.length || Boolean(parseError) || importing}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {importing && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              Import {rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Download,
  FileSpreadsheet,
  Link2,
  LoaderCircle,
  TriangleAlert,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { apiJson } from '../api';
import { csvCell, saveCsvFile } from '../attendanceExport';
import { parseCsv } from '../csvParse';
import {
  COMMIT_BATCH,
  flagRow,
  IMPORT_COLUMNS,
  importTemplateCsv,
  inBatches,
  isGoogleSheetLink,
  MAX_IMPORT_ROWS,
  PREVIEW_BATCH,
  readImportTable,
  roleLabel,
  splitRepeats,
  type FlaggedRow,
  type ImportRow,
} from '../instructorImport';
import type { College } from '../types';

/** A row as the server returns it once it has passed every check. */
interface PreviewValue {
  name: string;
  email: string;
  employee_id?: string;
  role: string;
  gender: string;
  college_id: string;
  phone_no?: string;
  photo_url: string;
  institute: string;
}

interface PreviewResult {
  row: number | null;
  ok: boolean;
  errors?: string[];
  value?: PreviewValue;
  thumbnail?: string | null;
}

interface CommitResult {
  row: number | null;
  ok: boolean;
  name?: string;
  photo_enrolled?: boolean;
  warning?: string;
  errors?: string[];
}

interface ReadyRow {
  row: number;
  value: PreviewValue;
  thumbnail: string | null;
}

interface ImportSummary {
  added: number;
  warnings: { row: number; name: string; warning: string }[];
  failed: FlaggedRow[];
  /** Why the import stopped early, when it did. */
  stoppedBecause: string;
}

type Stage = 'source' | 'checking' | 'preview' | 'importing' | 'done';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const REQUIRED_LABELS = IMPORT_COLUMNS.filter((column) => column.required).map((column) => column.label);
const OPTIONAL_LABELS = IMPORT_COLUMNS.filter((column) => !column.required).map((column) => column.label);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function genderLabel(gender: string): string {
  return gender === 'FEMALE' ? 'Female' : gender === 'MALE' ? 'Male' : gender;
}

interface InstructorImportDialogProps {
  colleges: College[];
  onClose: () => void;
  /** Called after an import that added at least one instructor. */
  onImported: (added: number) => void;
}

/**
 * Adds instructors from a CSV file or a Google Sheet.
 *
 * Nothing is written until the admin has seen the preview. The sheet is read
 * here, every row is checked by the server - photograph downloaded and its
 * face checked included - and the rows that pass are listed under Ready; the
 * rest go under Flagged with the reasons, and are never sent to be added.
 */
export default function InstructorImportDialog({ colleges, onClose, onImported }: InstructorImportDialogProps) {
  const [stage, setStage] = useState<Stage>('source');
  const [sourceError, setSourceError] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [loadingSheet, setLoadingSheet] = useState(false);
  const [sourceName, setSourceName] = useState('');
  const [ignoredColumns, setIgnoredColumns] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [ready, setReady] = useState<ReadyRow[]>([]);
  const [flagged, setFlagged] = useState<FlaggedRow[]>([]);
  const [tab, setTab] = useState<'ready' | 'flagged'>('ready');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const stopRequested = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);

  // Leaving the dialog abandons whatever is in flight.
  useEffect(() => () => {
    stopRequested.current = true;
    activeRequest.current?.abort();
  }, []);

  const busy = stage === 'checking' || stage === 'importing' || loadingSheet;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stage !== 'importing') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [stage, onClose]);

  const request = async <T,>(path: string, body: unknown): Promise<T> => {
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      return await apiJson<T>(path, { method: 'POST', body, signal: controller.signal, timeoutMs: 180_000 });
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  };

  /** Reads the sheet's rows and has the server check them, batch by batch. */
  const checkRows = async (csvText: string, name: string) => {
    const table = readImportTable(parseCsv(csvText));
    if (table.missingColumns.length) {
      const plural = table.missingColumns.length > 1 ? 's' : '';
      setSourceError(`The sheet is missing the required column${plural} ${table.missingColumns.join(', ')}. Download the template to see the headings the import expects.`);
      return;
    }
    if (!table.rows.length) {
      setSourceError('The sheet has headings but no instructors under them.');
      return;
    }
    if (table.rows.length > MAX_IMPORT_ROWS) {
      setSourceError(`The sheet has ${table.rows.length} rows. Import at most ${MAX_IMPORT_ROWS} at a time by splitting it into smaller files.`);
      return;
    }

    const { unique, flagged: repeats } = splitRepeats(table.rows);
    const passed: ReadyRow[] = [];
    const refused: FlaggedRow[] = [...repeats];
    const byRow = new Map<number, ImportRow>(unique.map((row) => [row.row, row]));
    setSourceName(name);
    setIgnoredColumns(table.ignoredColumns);
    setSourceError('');
    setStage('checking');
    setProgress({ done: 0, total: unique.length });
    stopRequested.current = false;

    try {
      for (const batch of inBatches(unique, PREVIEW_BATCH)) {
        if (stopRequested.current) return;
        const { results } = await request<{ results: PreviewResult[] }>('/api/v2/instructors/import/preview', { rows: batch });
        results.forEach((result, index) => {
          const sent = batch[index];
          const rowNumber = result.row ?? sent.row;
          if (result.ok && result.value) {
            passed.push({ row: rowNumber, value: result.value, thumbnail: result.thumbnail ?? null });
          } else {
            refused.push(flagRow(byRow.get(rowNumber) ?? sent, result.errors?.length ? result.errors : ['This row could not be checked']));
          }
        });
        setProgress((current) => ({ ...current, done: current.done + batch.length }));
      }
    } catch (error) {
      if (stopRequested.current) return;
      setStage('source');
      setSourceError(`Checking stopped: ${messageOf(error)}`);
      return;
    }

    passed.sort((a, b) => a.row - b.row);
    refused.sort((a, b) => a.row - b.row);
    setReady(passed);
    setFlagged(refused);
    setTab(passed.length ? 'ready' : 'flagged');
    setStage('preview');
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setSourceError('');
    if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) {
      setSourceError('Save the spreadsheet as CSV first (File > Download > CSV, or Save As > CSV), or paste its Google Sheets link.');
      return;
    }
    if (!/\.(csv|txt)$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) {
      setSourceError('Choose a .csv file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSourceError('The file is larger than 2 MB. Split it into smaller files.');
      return;
    }
    try {
      await checkRows(await file.text(), file.name);
    } catch (error) {
      setSourceError(`The file could not be read: ${messageOf(error)}`);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again, after fixing it, still fires.
    event.target.value = '';
    void readFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void readFile(event.dataTransfer.files?.[0]);
  };

  const handleSheetSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const link = sheetUrl.trim();
    if (!isGoogleSheetLink(link)) {
      setSourceError('Paste a Google Sheets link, starting https://docs.google.com/spreadsheets/');
      return;
    }
    setSourceError('');
    setLoadingSheet(true);
    try {
      const { csv } = await request<{ csv: string }>('/api/v2/instructors/import/sheet', { url: link });
      setLoadingSheet(false);
      await checkRows(csv, 'Google Sheet');
    } catch (error) {
      setSourceError(messageOf(error));
    } finally {
      setLoadingSheet(false);
    }
  };

  const downloadTemplate = () => {
    void saveCsvFile('instructor-import-template.csv', importTemplateCsv(colleges[0]?.name || undefined));
  };

  const downloadFlagged = (rows: FlaggedRow[]) => {
    const lines = [['Row', 'Name', 'Email', 'Reasons'], ...rows.map((row) => [String(row.row), row.name, row.email, row.errors.join('; ')])];
    void saveCsvFile('instructor-import-flagged.csv', lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n'));
  };

  /** Adds the Ready rows, a few at a time, and gathers what happened to each. */
  const importRows = async () => {
    const result: ImportSummary = { added: 0, warnings: [], failed: [], stoppedBecause: '' };
    stopRequested.current = false;
    setStage('importing');
    setProgress({ done: 0, total: ready.length });
    const byRow = new Map(ready.map((row) => [row.row, row]));

    for (const batch of inBatches(ready, COMMIT_BATCH)) {
      if (stopRequested.current) {
        result.stoppedBecause = 'You stopped the import. Rows after this point were not added.';
        break;
      }
      try {
        const { results } = await request<{ results: CommitResult[] }>('/api/v2/instructors/import', {
          // The institute goes by id, so a second institute with the same
          // name added since the preview cannot change where anyone lands.
          rows: batch.map(({ row, value }) => ({
            row,
            name: value.name,
            email: value.email,
            gender: value.gender,
            role: value.role,
            institute: value.college_id,
            employee_id: value.employee_id,
            phone_no: value.phone_no,
            photo_url: value.photo_url,
          })),
        });
        for (const outcome of results) {
          const original = byRow.get(outcome.row ?? -1);
          const name = outcome.name || original?.value.name || '';
          if (outcome.ok) {
            result.added += 1;
            if (outcome.warning) result.warnings.push({ row: outcome.row ?? 0, name, warning: outcome.warning });
          } else {
            result.failed.push({
              row: outcome.row ?? 0,
              name,
              email: original?.value.email ?? '',
              errors: outcome.errors?.length ? outcome.errors : ['This row could not be added'],
            });
          }
        }
      } catch (error) {
        result.stoppedBecause = `The import stopped: ${messageOf(error)}. The rows being added at that moment may or may not have been saved; importing the same sheet again flags any that were.`;
        break;
      }
      setProgress((current) => ({ ...current, done: current.done + batch.length }));
    }

    setSummary(result);
    setStage('done');
    if (result.added > 0) onImported(result.added);
  };

  const stop = () => {
    stopRequested.current = true;
    if (stage === 'checking') {
      activeRequest.current?.abort();
      setStage('source');
    }
  };

  const startOver = () => {
    setStage('source');
    setReady([]);
    setFlagged([]);
    setSummary(null);
    setSourceError('');
    setIgnoredColumns([]);
  };

  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <div className="bg-white rounded-md shadow-xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[94vh]">
        <div className="px-4 py-4 sm:p-6 border-b border-slate-100 flex justify-between items-center gap-3 bg-slate-50/50">
          <div className="min-w-0">
            <h2 id="import-dialog-title" className="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2">
              <FileSpreadsheet size={20} className="text-indigo-600 shrink-0" aria-hidden="true" />
              Import Instructors
            </h2>
            {sourceName && stage !== 'source' && (
              <p className="mt-0.5 truncate text-xs font-medium text-slate-500">From {sourceName}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close import dialog"
            title={stage === 'importing' ? 'Stop the import first' : 'Close'}
            onClick={onClose}
            disabled={stage === 'importing'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-600 shadow-sm transition-colors hover:border-rose-600 hover:bg-rose-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            <X size={18} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>

        {stage === 'source' && (
          <div className="p-4 sm:p-6 overflow-y-auto space-y-5">
            {sourceError && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
                <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{sourceError}</span>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
                  dragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-slate-50'
                }`}
              >
                <Upload size={28} className="text-indigo-600" aria-hidden="true" />
                <div>
                  <p className="text-sm font-bold text-slate-800">Upload a CSV file</p>
                  <p className="mt-1 text-xs text-slate-500">Drop it here, or choose it from your computer.</p>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  id="import-file"
                  onChange={handleFileChange}
                  disabled={busy}
                />
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  className="rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
                >
                  Choose CSV file
                </button>
              </div>

              <form onSubmit={handleSheetSubmit} className="flex flex-col justify-center gap-3 rounded-lg border border-slate-200 p-6">
                <div className="flex items-center gap-2">
                  <Link2 size={20} className="text-indigo-600" aria-hidden="true" />
                  <label htmlFor="import-sheet-url" className="text-sm font-bold text-slate-800">Or paste a Google Sheets link</label>
                </div>
                <p className="text-xs text-slate-500">Share the sheet as “Anyone with the link can view” first. The tab the link opens on is the one imported.</p>
                <input
                  id="import-sheet-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={sheetUrl}
                  onChange={(event) => setSheetUrl(event.target.value)}
                  disabled={busy}
                  className="w-full rounded-md border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all"
                />
                <button
                  type="submit"
                  disabled={busy || !sheetUrl.trim()}
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                >
                  {loadingSheet && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
                  {loadingSheet ? 'Loading sheet…' : 'Load sheet'}
                </button>
              </form>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <p><span className="font-bold text-slate-800">Required columns:</span> {REQUIRED_LABELS.join(', ')}</p>
                  <p><span className="font-bold text-slate-800">Optional:</span> {OPTIONAL_LABELS.join(', ')}</p>
                  <p className="text-xs text-slate-500">
                    Gender is Male or Female. Role is Instructor, Central Instructor, Mentor or Other. Institute is the
                    institute’s name as it appears here, or its ID. Photo Link is a public link to a clear, front-facing
                    photo (a Google Drive link shared with anyone works). Rows with a problem are listed under Flagged
                    and not added.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 transition-colors hover:bg-indigo-100"
                >
                  <Download size={14} aria-hidden="true" />
                  Download template
                </button>
              </div>
            </div>
          </div>
        )}

        {(stage === 'checking' || stage === 'importing') && (
          <div className="p-6 sm:p-10 flex flex-col items-center gap-4 text-center" aria-live="polite">
            <LoaderCircle size={32} className="animate-spin text-indigo-600" aria-hidden="true" />
            <div>
              <p className="text-base font-bold text-slate-800">
                {stage === 'checking'
                  ? `Checking ${progress.done} of ${progress.total} rows…`
                  : `Adding ${progress.done} of ${progress.total} instructors…`}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {stage === 'checking'
                  ? 'Each photo is downloaded and its face checked, so this takes a moment per row.'
                  : 'Each photo is being stored and enrolled for face recognition.'}
              </p>
            </div>
            <div className="h-2 w-full max-w-md overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${percent}%` }} />
            </div>
            <button type="button" onClick={stop} className="rounded-md bg-slate-100 px-4 py-2 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-200">
              {stage === 'checking' ? 'Cancel' : 'Stop after this batch'}
            </button>
          </div>
        )}

        {stage === 'preview' && (
          <>
            <div className="flex items-center gap-1 border-b border-slate-100 px-4 sm:px-6" role="tablist" aria-label="Import preview">
              {([
                ['ready', `Ready to add (${ready.length})`],
                ['flagged', `Flagged (${flagged.length})`],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-3 py-3 text-sm font-bold transition-colors ${
                    tab === key
                      ? key === 'flagged' ? 'border-rose-600 text-rose-700' : 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
              {ignoredColumns.length > 0 && tab === 'ready' && (
                <p className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500 sm:px-6">
                  Not imported, as they match no instructor field: {ignoredColumns.join(', ')}.
                </p>
              )}
              {tab === 'ready' ? (
                ready.length === 0 ? (
                  <p className="p-8 text-center text-sm font-medium text-slate-500">No row passed the checks. See Flagged for the reasons.</p>
                ) : (
                  <>
                  {/* A card per row on a phone, where the table's columns do
                      not fit; the table from tablet width up. */}
                  <ul className="divide-y divide-slate-100 sm:hidden">
                    {ready.map(({ row, value, thumbnail }) => (
                      <li key={row} className="flex items-start gap-3 px-4 py-3">
                        <Thumbnail src={thumbnail} name={value.name} />
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="font-bold text-slate-800">{value.name}</p>
                          <p className="truncate text-xs text-slate-500">{value.email}</p>
                          <p className="mt-1 text-xs text-slate-600">
                            {[genderLabel(value.gender), roleLabel(value.role), value.institute].join(' · ')}
                          </p>
                          {(value.employee_id || value.phone_no) && (
                            <p className="text-xs text-slate-500">{[value.employee_id, value.phone_no].filter(Boolean).join(' · ')}</p>
                          )}
                        </div>
                        <span className="font-mono text-xs text-slate-400">Row {row}</span>
                      </li>
                    ))}
                  </ul>
                  <table className="hidden w-full min-w-[720px] text-left text-sm sm:table">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Row</th>
                        <th className="px-2 py-3">Photo</th>
                        <th className="px-4 py-3">Name</th>
                        <th className="px-4 py-3">Gender</th>
                        <th className="px-4 py-3">Role</th>
                        <th className="px-4 py-3">Institute</th>
                        <th className="px-4 py-3">Employee ID</th>
                        <th className="px-4 py-3">Phone</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ready.map(({ row, value, thumbnail }) => (
                        <tr key={row}>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{row}</td>
                          <td className="px-2 py-2.5"><Thumbnail src={thumbnail} name={value.name} /></td>
                          <td className="px-4 py-2.5">
                            <span className="block font-bold text-slate-800">{value.name}</span>
                            <span className="block text-xs text-slate-500">{value.email}</span>
                          </td>
                          <td className="px-4 py-2.5 text-slate-700">{genderLabel(value.gender)}</td>
                          <td className="px-4 py-2.5 text-slate-700">{roleLabel(value.role)}</td>
                          <td className="px-4 py-2.5 text-slate-700">{value.institute}</td>
                          <td className="px-4 py-2.5 text-slate-700">{value.employee_id || '—'}</td>
                          <td className="px-4 py-2.5 text-slate-700">{value.phone_no || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </>
                )
              ) : flagged.length === 0 ? (
                <p className="p-8 text-center text-sm font-medium text-slate-500">Every row passed the checks.</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-100 bg-rose-50 px-4 py-2.5 sm:px-6">
                    <p className="text-sm font-medium text-rose-700">These rows will not be added. Fix them in the sheet and import them again.</p>
                    <button
                      type="button"
                      onClick={() => downloadFlagged(flagged)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100"
                    >
                      <Download size={14} aria-hidden="true" />
                      Download flagged rows
                    </button>
                  </div>
                  <FlaggedTable rows={flagged} />
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-4 sm:px-6">
              <p className="text-sm text-slate-600">
                <span className="font-bold text-slate-800">{ready.length}</span> ready ·{' '}
                <span className={`font-bold ${flagged.length ? 'text-rose-700' : 'text-slate-800'}`}>{flagged.length}</span> flagged
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={startOver} className="rounded-md bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-200">
                  Choose another file
                </button>
                <button
                  type="button"
                  onClick={() => { void importRows(); }}
                  disabled={!ready.length}
                  className="rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:shadow-none"
                >
                  {ready.length === 0 ? 'Nothing to add' : ready.length === 1 ? 'Add 1 instructor' : `Add ${ready.length} instructors`}
                </button>
              </div>
            </div>
          </>
        )}

        {stage === 'done' && summary && (
          <>
            <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6 space-y-4">
              <div className={`flex items-start gap-3 rounded-md border p-4 ${summary.added ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`} role="status">
                <CircleCheck size={22} className={summary.added ? 'text-emerald-600' : 'text-slate-400'} aria-hidden="true" />
                <div>
                  <p className="font-bold text-slate-800">
                    {summary.added === 1 ? 'Added 1 instructor.' : `Added ${summary.added} instructors.`}
                  </p>
                  {flagged.length > 0 && (
                    <p className="mt-0.5 text-sm text-slate-600">{flagged.length} flagged {flagged.length === 1 ? 'row was' : 'rows were'} left out.</p>
                  )}
                </div>
              </div>

              {summary.stoppedBecause && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">
                  <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{summary.stoppedBecause}</span>
                </div>
              )}

              {summary.warnings.length > 0 && (
                <div className="rounded-md border border-amber-200">
                  <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800">
                    Added without a photo — add one from Edit
                  </p>
                  <ul className="divide-y divide-amber-100 text-sm">
                    {summary.warnings.map((warning) => (
                      <li key={warning.row} className="px-4 py-2 text-slate-700">
                        <span className="font-mono text-xs text-slate-400">Row {warning.row}</span>{' '}
                        <span className="font-bold">{warning.name}</span>: {warning.warning.replace(/^Added, but /, '')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {summary.failed.length > 0 && (
                <div className="rounded-md border border-rose-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2">
                    <p className="text-sm font-bold text-rose-700">Not added — something changed since the preview</p>
                    <button type="button" onClick={() => downloadFlagged(summary.failed)} className="inline-flex items-center gap-1.5 text-xs font-bold text-rose-700 hover:underline">
                      <Download size={14} aria-hidden="true" />
                      Download
                    </button>
                  </div>
                  <FlaggedTable rows={summary.failed} />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-4 sm:px-6">
              <button type="button" onClick={startOver} className="rounded-md bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 transition-colors hover:bg-slate-200">
                Import another file
              </button>
              <button type="button" onClick={onClose} className="rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 transition-colors hover:bg-indigo-700">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Thumbnail({ src, name }: { src: string | null; name: string }) {
  return src ? (
    <img src={src} alt={`Photo of ${name}`} className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-slate-200" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400"><UserRound size={18} aria-hidden="true" /></span>
  );
}

function Reasons({ errors }: { errors: string[] }) {
  return (
    <ul className="space-y-1">
      {errors.map((error) => (
        <li key={error} className="flex items-start gap-1.5 text-rose-700">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </li>
      ))}
    </ul>
  );
}

function FlaggedTable({ rows }: { rows: FlaggedRow[] }) {
  return (
    <>
    <ul className="divide-y divide-slate-100 sm:hidden">
      {rows.map((row) => (
        <li key={`${row.row}-${row.email}`} className="px-4 py-3 text-sm">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <p className="min-w-0 truncate font-bold text-slate-800">{row.name || row.email || 'No name'}</p>
            <span className="shrink-0 font-mono text-xs text-slate-400">Row {row.row}</span>
          </div>
          {row.name && row.email && <p className="mb-1.5 truncate text-xs text-slate-500">{row.email}</p>}
          <Reasons errors={row.errors} />
        </li>
      ))}
    </ul>
    <table className="hidden w-full text-left text-sm sm:table">
      <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
        <tr>
          <th className="px-4 py-3 w-16">Row</th>
          <th className="px-4 py-3">Name</th>
          <th className="px-4 py-3">Why it was flagged</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={`${row.row}-${row.email}`} className="align-top">
            <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{row.row}</td>
            <td className="px-4 py-2.5">
              <span className="block font-bold text-slate-800">{row.name || '—'}</span>
              {row.email && <span className="block text-xs text-slate-500">{row.email}</span>}
            </td>
            <td className="px-4 py-2.5"><Reasons errors={row.errors} /></td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

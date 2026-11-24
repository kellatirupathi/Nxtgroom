// Shared pieces of the institute grooming-photo form: the public page each
// institute fills in from its own link, and the admin Form Responses table.
import { parseCsv } from '../csvParse.ts';
import { csvCell } from '../attendanceExport.ts';

export const FORM_MAX_PHOTOS = 5;
export const FORM_MAX_FILE_MB = 10;
export const FORM_MAX_FILE_BYTES = FORM_MAX_FILE_MB * 1024 * 1024;
export const FORM_TITLE = 'Daily Appearance Photo Submission';

export type FormStatus = 'yes' | 'no';
export type FormReason = 'wfh' | 'university_holiday' | 'other';
export type FormSource = 'automatic' | 'manual';

export const FORM_STATUS_OPTIONS: ReadonlyArray<{ value: FormStatus; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

export const FORM_REASON_OPTIONS: ReadonlyArray<{ value: FormReason; label: string }> = [
  { value: 'wfh', label: 'WFH' },
  { value: 'university_holiday', label: 'University Holiday' },
  { value: 'other', label: 'Other' },
];

export const FORM_SOURCE_OPTIONS: ReadonlyArray<{ value: FormSource; label: string }> = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
];

// How a person in a photo got their name: read from the label printed next to
// them, chosen by the submitter, or not named.
export type PersonSource = 'label' | 'manual' | 'none';

// One person cut out of a form photo by the submitter's browser.
export interface FormPerson {
  id: string;
  instructor_id: string | null;
  name: string | null;
  employee_id: string | null;
  source: PersonSource;
  box: { left: number; top: number; width: number; height: number } | null;
  crop_url: string | null;
}

export interface FormPhoto {
  id: string;
  url: string | null;
  thumb_url: string | null;
  people?: FormPerson[];
}

// An instructor of the institute, for the name list.
export interface FormInstructor {
  id: string;
  name: string;
  employee_id: string;
}

export interface PersonRow extends FormPerson {
  key: string;
  matched: boolean;
  label: string;
}

// Everyone across a response's photos for the Name | ID | Image table: named
// people first (A-Z, each once), then the people left without a name, in
// photo order.
export function peopleRows(photos: readonly FormPhoto[]): PersonRow[] {
  const named = new Map<string, PersonRow>();
  const others: PersonRow[] = [];
  photos.forEach((photo) => {
    (photo.people ?? []).forEach((person, personIndex) => {
      const matched = Boolean(person.instructor_id && person.name);
      const row: PersonRow = {
        ...person,
        key: `${photo.id}-${person.id || personIndex}`,
        matched,
        label: matched ? String(person.name) : 'Not named',
      };
      if (!matched) {
        others.push(row);
        return;
      }
      if (!named.has(String(person.instructor_id))) named.set(String(person.instructor_id), row);
    });
  });
  const sorted = [...named.values()].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
  return [...sorted, ...others];
}

export interface PeopleCount {
  identified: number;
  unknown: number;
}

export function peopleCount(photos: readonly FormPhoto[]): PeopleCount {
  const rows = peopleRows(photos);
  return {
    identified: rows.filter((row) => row.matched).length,
    unknown: rows.filter((row) => !row.matched).length,
  };
}

export interface FormResponse {
  _id: string;
  college_id: string;
  college_name: string;
  form_date: string;
  status: FormStatus;
  submitted_by: string;
  reason: FormReason | null;
  reason_other: string;
  reason_label: string;
  photos: FormPhoto[];
  photo_links: string[];
  source: FormSource;
  submitted_at: string | null;
  updated_at: string | null;
  edit_count: number;
}

export interface PublicFormData {
  institute: { name: string; location: string };
  date: string;
  today: string;
  limits: { max_photos: number; max_file_mb: number };
  response: FormResponse | null;
}

export interface FormLink {
  college_id: string;
  name: string;
  location: string;
  token: string;
  path: string;
}

export function statusLabel(status: string | null | undefined): string {
  return FORM_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? '';
}

export function sourceLabel(source: string | null | undefined): string {
  return FORM_SOURCE_OPTIONS.find((option) => option.value === source)?.label ?? 'Automatic';
}

// The reason column: the chosen reason, or "Other" for anything typed in.
export function reasonCategory(reason: string | null | undefined): string {
  return FORM_REASON_OPTIONS.find((option) => option.value === reason)?.label ?? '';
}

// ---- dates ------------------------------------------------------------------

function realDate(year: number, month: number, day: number): boolean {
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

// 2026-11-23 -> 23_11_2026, the date as the form's address writes it.
export function urlDateFromKey(key: string): string {
  const [year, month, day] = key.split('-');
  return `${day}_${month}_${year}`;
}

// 23_11_2026 -> 2026-11-23, or null for anything that is not a real date.
export function keyFromUrlDate(value: string): string | null {
  const match = /^(\d{2})_(\d{2})_(\d{4})$/.exec(value);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return realDate(year, month, day) ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

// 2026-11-23 -> 23-11-2026
export function displayDate(key: string): string {
  const [year, month, day] = String(key || '').split('-');
  return year && month && day ? `${day}-${month}-${year}` : '';
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 2026-11-23 -> 23 Nov 2026
export function longDate(key: string): string {
  const [year, month, day] = String(key || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

export function formatMoment(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export const MONTH_TITLES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface CalendarDay {
  key: string;
  day: number;
  inMonth: boolean;
}

function keyFromUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// The days shown for a month (1-12) in the form's calendar, in whole weeks
// starting on Monday, with the neighbouring months' days filling the edges.
export function calendarDays(year: number, month: number): CalendarDay[] {
  const offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;
  return Array.from({ length: total }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, 1 - offset + index));
    return { key: keyFromUtc(date), day: date.getUTCDate(), inMonth: date.getUTCMonth() === month - 1 };
  });
}

// The month (1-12) a number of months away, keeping the year in step.
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

// The day before a YYYY-MM-DD date.
export function dayBefore(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return keyFromUtc(new Date(Date.UTC(year, month - 1, day - 1)));
}

// /form/<slug>/<token>, with /DD_MM_YYYY when a date is given.
export function formPagePath(slug: string, token: string, dateKey?: string | null): string {
  const base = `/form/${slug}/${token}`;
  return dateKey ? `${base}/${urlDateFromKey(dateKey)}` : base;
}

// ---- importing an existing sheet -------------------------------------------

export interface FormImportRow {
  row: number;
  date: string;
  status: string;
  university: string;
  picture: string;
  submitted_by: string;
  reason: string;
  timestamp: string;
}

export const IMPORT_TEMPLATE_HEADERS = [
  'Timestamp',
  'Date',
  'Photo Submission Status',
  'University Name',
  'Grooming Picture',
  'Submitted By',
  'Reason for Non Submission',
] as const;

type ImportField = Exclude<keyof FormImportRow, 'row'>;

const REQUIRED_IMPORT_FIELDS: ReadonlyArray<[ImportField, string]> = [
  ['date', 'Date'],
  ['status', 'Photo Submission Status'],
  ['university', 'University Name'],
  ['submitted_by', 'Submitted By'],
];

function headerField(header: string): ImportField | null {
  const name = header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!name) return null;
  if (name === 'timestamp' || name === 'submitted at') return 'timestamp';
  if (name === 'date' || name === 'form date') return 'date';
  if (name.includes('status')) return 'status';
  if (name.includes('university') || name.includes('institute') || name.includes('campus')) return 'university';
  if (name.includes('submitted by')) return 'submitted_by';
  if (name.includes('reason')) return 'reason';
  if (name.includes('picture') || name.includes('photo') || name.includes('image')) return 'picture';
  return null;
}

// The rows of a CSV exported from the Google Form's sheet (or the template),
// matched to the form's questions by their column titles.
export function importRowsFromCsv(text: string): { rows: FormImportRow[]; error?: string } {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return { rows: [], error: 'The file has no rows under its header.' };
  const [header, ...body] = parsed;
  const columns = new Map<ImportField, number>();
  header.cells.forEach((cell, index) => {
    const field = headerField(cell);
    if (field && !columns.has(field)) columns.set(field, index);
  });
  const missing = REQUIRED_IMPORT_FIELDS.filter(([field]) => !columns.has(field)).map(([, title]) => title);
  if (missing.length) {
    return { rows: [], error: `The file is missing these columns: ${missing.join(', ')}.` };
  }
  const read = (cells: string[], field: ImportField) => {
    const index = columns.get(field);
    return index === undefined ? '' : String(cells[index] ?? '').trim();
  };
  const rows = body.map(({ row, cells }) => ({
    row,
    date: read(cells, 'date'),
    status: read(cells, 'status'),
    university: read(cells, 'university'),
    picture: read(cells, 'picture'),
    submitted_by: read(cells, 'submitted_by'),
    reason: read(cells, 'reason'),
    timestamp: read(cells, 'timestamp'),
  }));
  return { rows };
}

export function importTemplateCsv(): string {
  const example = [
    '23/11/2026 10:04:31',
    '23-11-2026',
    'Yes',
    'Aurora University',
    'https://drive.google.com/open?id=example',
    'Ravi Kumar',
    '',
  ];
  const holiday = ['23/11/2026 18:10:00', '23-11-2026', 'No', 'GMRIT', '', 'Sita Devi', 'University Holiday'];
  return [IMPORT_TEMPLATE_HEADERS, example, holiday].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

// ---- export -------------------------------------------------------------------

const EXPORT_COLUMNS: ReadonlyArray<[string, (row: FormResponse) => unknown]> = [
  ['Date', (row) => displayDate(row.form_date)],
  ['University Name', (row) => row.college_name],
  ['Photo Submission Status', (row) => statusLabel(row.status)],
  ['Appearance Picture', (row) => [...row.photos.map((photo) => photo.url).filter(Boolean), ...row.photo_links].join(' , ')],
  ['Photos', (row) => row.photos.length + row.photo_links.length],
  ['People Identified', (row) => peopleRows(row.photos)
    .filter((person) => person.matched)
    .map((person) => (person.employee_id ? `${person.label} (${person.employee_id})` : person.label))
    .join('; ')],
  ['Unknown People', (row) => peopleRows(row.photos).filter((person) => !person.matched).length],
  ['Submitted By', (row) => row.submitted_by],
  ['Reason for Non Submission', (row) => row.reason_label],
  ['Type', (row) => sourceLabel(row.source)],
  ['Submitted At', (row) => formatMoment(row.submitted_at)],
  ['Last Updated', (row) => formatMoment(row.updated_at)],
];

export function formResponsesCsv(rows: FormResponse[]): string {
  const header = EXPORT_COLUMNS.map(([title]) => csvCell(title)).join(',');
  const lines = rows.map((row) => EXPORT_COLUMNS.map(([, read]) => csvCell(read(row))).join(','));
  return [header, ...lines].join('\r\n');
}

export function formResponsesFileName(from: string, to: string): string {
  if (!from && !to) return 'form-responses-all.csv';
  return from === to || !to ? `form-responses-${from}.csv` : `form-responses-${from}_to_${to}.csv`;
}

// ---- photos -------------------------------------------------------------------

const PASS_THROUGH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SHRINK_ABOVE_BYTES = 1024 * 1024;
const MAX_UPLOAD_DIMENSION = 2048;

// Phone photos are shrunk to at most 2048 px (JPEG) before upload, so five of
// them and their people's cut-outs stay well inside the server's 10 MB limit
// and send quickly on a mobile connection; this also turns iPhone HEIC photos
// into JPEG where the browser can open them. Small JPG/PNG/WebP files go as
// they are. (People are found and cut out from the full-size original.)
export async function prepareFormPhoto(file: File): Promise<File> {
  if (PASS_THROUGH_TYPES.has(file.type) && file.size <= SHRINK_ABOVE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('no image');
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' });
  } catch {
    if (PASS_THROUGH_TYPES.has(file.type)) return file;
    throw new Error(`${file.name} is not a supported photo. Choose a JPG or PNG photo.`);
  }
}

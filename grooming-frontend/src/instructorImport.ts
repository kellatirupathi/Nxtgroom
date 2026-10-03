import { csvCell } from './attendanceExport.ts';
import type { CsvRow } from './csvParse.ts';
import { INSTRUCTOR_ROLES } from './instructorRoles.ts';
import type { College } from './types.ts';

export type ImportField =
  | 'name'
  | 'email'
  | 'gender'
  | 'role'
  | 'institute'
  | 'employee_id'
  | 'phone_no'
  | 'photo_url';

interface ImportColumn {
  field: ImportField;
  label: string;
  required: boolean;
  aliases: string[];
}

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { field: 'name', label: 'Name', required: true, aliases: ['full name', 'instructor name', 'faculty name'] },
  { field: 'email', label: 'Email', required: true, aliases: ['email id', 'email address', 'mail id', 'e-mail'] },
  { field: 'gender', label: 'Gender', required: true, aliases: ['sex'] },
  { field: 'role', label: 'Role', required: true, aliases: ['instructor role'] },
  {
    field: 'institute',
    label: 'Institute',
    required: true,
    aliases: ['institute name', 'institute id', 'college', 'college name', 'college id', 'campus'],
  },
  {
    field: 'employee_id',
    label: 'Employee ID',
    required: true,
    aliases: ['emp id', 'employee code', 'emp code', 'employee no', 'employee number'],
  },
  {
    field: 'phone_no',
    label: 'Phone',
    required: false,
    aliases: ['phone no', 'phone number', 'mobile', 'mobile no', 'mobile number', 'contact number'],
  },
  {
    field: 'photo_url',
    label: 'Photo Link',
    required: true,
    aliases: ['photo', 'photo url', 'image', 'image link', 'image url', 'picture', 'profile photo', 'reference photo'],
  },
];

export const MAX_IMPORT_ROWS = 1000;
export const PREVIEW_BATCH = 50;
export const COMMIT_BATCH = 25;
export const PARALLEL_BATCHES = 3;

export async function runBatches<T>(
  batches: readonly T[][],
  parallel: number,
  work: (batch: T[]) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown = null;
  const worker = async () => {
    while (!failed && next < batches.length && !shouldStop()) {
      const batch = batches[next];
      next += 1;
      try {
        await work(batch);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  if (failed) throw failure;
}

function headingKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\s*(q(uestion)?\s*)?\d+\s*[.):-]?\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

const FIELD_BY_HEADING = new Map<string, ImportField>(
  IMPORT_COLUMNS.flatMap((column) => [column.label, column.field, ...column.aliases]
    .map((heading) => [headingKey(heading), column.field] as [string, ImportField])),
);

const HEADING_KEYWORDS: ReadonlyArray<[ImportField, RegExp]> = [
  ['photo_url', /photo|image|picture|pic|selfie/],
  ['email', /mail/],
  ['phone_no', /phone|mobile|contact|whatsapp/],
  ['gender', /gender|sex/],
  ['employee_id', /^(emp|employee|staff)\w*?(id|code|no|number)/],
  ['role', /role|designation|position/],
  ['institute', /institute|college|campus|centre|center|branch/],
  ['name', /name/],
];

export function headingField(heading: string): ImportField | null {
  const key = headingKey(heading);
  if (!key) return null;
  const known = FIELD_BY_HEADING.get(key);
  if (known) return known;
  return HEADING_KEYWORDS.find(([, pattern]) => pattern.test(key))?.[0] ?? null;
}

const MULTI_VALUE_SEPARATORS: Record<ImportField, RegExp> = {
  name: /[\n;|]/,
  email: /[\s,;/|]+/,
  gender: /[\s,;/|]+/,
  role: /[\n,;/|]/,
  institute: /[\n;|]/,
  employee_id: /[\s,;/|]+/,
  phone_no: /[\n,;/|]/,
  photo_url: /[\s,;|]+/,
};

export function firstValue(field: ImportField, value: string): string {
  return value.split(MULTI_VALUE_SEPARATORS[field]).map((part) => part.trim()).find(Boolean) ?? '';
}

export type ImportRow = { row: number } & Partial<Record<ImportField, string>>;

export interface ImportTable {
  rows: ImportRow[];
  missingColumns: string[];
  hasIdentifier: boolean;
  ignoredColumns: string[];
}

export function readImportTable(csvRows: CsvRow[]): ImportTable {
  const [header, ...body] = csvRows;
  if (!header) {
    return { rows: [], missingColumns: IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.label), hasIdentifier: false, ignoredColumns: [] };
  }
  const fieldAt = header.cells.map((heading) => headingField(heading));
  const present = new Set(fieldAt.filter(Boolean));
  const missingColumns = IMPORT_COLUMNS
    .filter((column) => column.required && !present.has(column.field))
    .map((column) => column.label);
  const ignoredColumns = header.cells
    .filter((heading, index) => heading.trim() && !fieldAt[index])
    .map((heading) => heading.trim());

  const rows = body.map((csvRow) => {
    const row: ImportRow = { row: csvRow.row };
    csvRow.cells.forEach((value, index) => {
      const field = fieldAt[index];
      if (field && !row[field]) row[field] = firstValue(field, value);
    });
    return row;
  });
  return { rows, missingColumns, hasIdentifier: present.has('email') || present.has('employee_id'), ignoredColumns };
}

export interface FlaggedRow {
  row: number;
  name: string;
  email: string;
  errors: string[];
  raw: ImportRow;
}

export function flagRow(row: ImportRow, errors: string[]): FlaggedRow {
  return { row: row.row, name: row.name ?? '', email: row.email ?? '', errors, raw: row };
}

const ERROR_FIELDS: ReadonlyArray<[RegExp, ImportField]> = [
  [/^Name\b/, 'name'],
  [/email/i, 'email'],
  [/^Gender\b/, 'gender'],
  [/^Role\b/, 'role'],
  [/^Institute\b/, 'institute'],
  [/Employee ID/, 'employee_id'],
  [/^Phone\b/, 'phone_no'],
  [/^Photo\b/, 'photo_url'],
];

export function fieldsInError(errors: readonly string[]): Set<ImportField> {
  const fields = new Set<ImportField>();
  for (const error of errors) {
    for (const [pattern, field] of ERROR_FIELDS) if (pattern.test(error)) fields.add(field);
  }
  return fields;
}

export function hasIdentifier(row: ImportRow): boolean {
  return Boolean((row.email ?? '').trim() || (row.employee_id ?? '').trim());
}

export function blankRequiredFields(row: ImportRow): string[] {
  return IMPORT_COLUMNS
    .filter((column) => column.required && column.field !== 'photo_url' && !(row[column.field] ?? '').trim())
    .map((column) => column.label);
}

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function guessGender(value: string | undefined): string {
  const key = comparable(firstValue('gender', value ?? ''));
  if (['m', 'male', 'man'].includes(key)) return 'MALE';
  if (['f', 'female', 'woman'].includes(key)) return 'FEMALE';
  return '';
}

export function guessRole(value: string | undefined): string {
  const key = comparable(firstValue('role', value ?? ''));
  return INSTRUCTOR_ROLES.find((role) => comparable(role) === key) ?? '';
}

export function guessCollegeId(value: string | undefined, colleges: readonly College[]): string {
  const wanted = firstValue('institute', value ?? '');
  if (!wanted) return '';
  const byId = colleges.find((college) => String(college._id) === wanted);
  if (byId) return String(byId._id);
  const byName = colleges.filter((college) => comparable(college.name) === comparable(wanted));
  return byName.length === 1 ? String(byName[0]._id) : '';
}

export function repeatsOf(row: ImportRow, others: ReadonlyArray<{ row: number; email: string; employee_id?: string }>): string[] {
  const email = (row.email ?? '').trim().toLowerCase();
  const employeeId = (row.employee_id ?? '').trim();
  const errors: string[] = [];
  const sameEmail = others.find((other) => other.row !== row.row && email && other.email.toLowerCase() === email);
  const sameId = others.find((other) => other.row !== row.row && employeeId && other.employee_id === employeeId);
  if (sameEmail) errors.push(`Same email as row ${sameEmail.row}`);
  if (sameId) errors.push(`Same Employee ID as row ${sameId.row}`);
  return errors;
}

export function splitRepeats(rows: ImportRow[]): { unique: ImportRow[]; flagged: FlaggedRow[] } {
  const firstByEmail = new Map<string, number>();
  const firstById = new Map<string, number>();
  const unique: ImportRow[] = [];
  const flagged: FlaggedRow[] = [];
  for (const row of rows) {
    const email = (row.email ?? '').trim().toLowerCase();
    const employeeId = (row.employee_id ?? '').trim();
    const errors: string[] = [];
    if (email && firstByEmail.has(email)) errors.push(`Same email as row ${firstByEmail.get(email)}`);
    if (employeeId && firstById.has(employeeId)) errors.push(`Same Employee ID as row ${firstById.get(employeeId)}`);
    if (errors.length) {
      flagged.push(flagRow(row, errors));
      continue;
    }
    if (email) firstByEmail.set(email, row.row);
    if (employeeId) firstById.set(employeeId, row.row);
    unique.push(row);
  }
  return { unique, flagged };
}

export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}

export function isGoogleSheetLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/');
  } catch {
    return false;
  }
}

export function roleLabel(role: string): string {
  return role
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function importTemplateCsv(exampleInstitute = 'Your institute name'): string {
  const example = [
    'Asha Rao',
    'asha.rao@example.com',
    'Female',
    'Instructor',
    exampleInstitute,
    'EMP001',
    '9876543210',
    'https://drive.google.com/file/d/FILE_ID/view',
  ];
  return [IMPORT_COLUMNS.map((column) => column.label), example]
    .map((cells) => cells.map(csvCell).join(','))
    .join('\r\n');
}

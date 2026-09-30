import { csvCell } from './attendanceExport.ts';
import type { CsvRow } from './csvParse.ts';
import { INSTRUCTOR_ROLES } from './instructorRoles.ts';
import type { College } from './types.ts';

/**
 * Turning a spreadsheet into instructor rows for the import.
 *
 * The browser only finds the columns, drops repeats and batches the rows; the
 * server decides whether each value is acceptable, so the rules live in one
 * place and a sheet cannot pass here and fail there.
 */

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
  /** The heading the template uses. */
  label: string;
  required: boolean;
  /** Other headings people use for the same column, compared loosely. */
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
    // Optional for now: the source data often lacks it. A blank one leaves
    // the instructor without an institute until an admin assigns it.
    required: false,
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

/** Most rows one import takes; a larger roster is split across files. */
export const MAX_IMPORT_ROWS = 1000;
/** Rows per check request, matching the server's limit. */
export const PREVIEW_BATCH = 25;
/** Rows per add request, matching the server's limit. */
export const COMMIT_BATCH = 5;

/**
 * A heading reduced to lower-case letters and digits, so case, spacing,
 * punctuation and a leading question number never matter: "Photo Link",
 * "photo_link", "PHOTO LINK *" and "6. Photo Link" are the same heading.
 */
function headingKey(value: string): string {
  return value
    .toLowerCase()
    // A question number from a form, as in "2. Employee ID" or "Q3) Email":
    // left in, it made "2employeeid", which matched no column, and every row
    // was flagged as having no Employee ID.
    .replace(/^\s*(q(uestion)?\s*)?\d+\s*[.):-]?\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

const FIELD_BY_HEADING = new Map<string, ImportField>(
  IMPORT_COLUMNS.flatMap((column) => [column.label, column.field, ...column.aliases]
    .map((heading) => [headingKey(heading), column.field] as [string, ImportField])),
);

/**
 * Words that identify a column when its heading is not one of the known
 * names, such as "Official Email" or "Employee Code (required)". Tried in
 * this order, so "Employee Name" is a name rather than an employee ID and
 * "Institute Email" is an email rather than an institute.
 */
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

/**
 * What separates two values typed into one cell, per field; the server
 * applies the same split. A comma is part of a name ("Nair, Anjali") and a
 * slash part of every link, so those split only where they cannot belong to
 * a single value.
 */
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

/** The first of several values in one cell, or the whole cell when there is one. */
export function firstValue(field: ImportField, value: string): string {
  return value.split(MULTI_VALUE_SEPARATORS[field]).map((part) => part.trim()).find(Boolean) ?? '';
}

export type ImportRow = { row: number } & Partial<Record<ImportField, string>>;

export interface ImportTable {
  rows: ImportRow[];
  /**
   * Template headings of required columns the sheet does not have. Not fatal:
   * an instructor already in the roster keeps what is on record for them;
   * only a new instructor's row is flagged without them.
   */
  missingColumns: string[];
  /**
   * Whether the sheet has an Email or Employee ID column. Without one no row
   * can be matched to the roster, so the sheet cannot be imported at all.
   */
  hasIdentifier: boolean;
  /** Headings that match no column, left out of the import. */
  ignoredColumns: string[];
}

/**
 * Finds the columns by their headings - in any order, any case, and under
 * the usual alternative names - and reads each row into them. The first row
 * of the sheet is the heading row.
 *
 * Where there are two of something, the first is used: of two columns for
 * the same field, the first that has a value in that row, and of two values
 * in one cell, the first value.
 */
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
  /** The row's values as read from the sheet, so it can be corrected. */
  raw: ImportRow;
}

export function flagRow(row: ImportRow, errors: string[]): FlaggedRow {
  return { row: row.row, name: row.name ?? '', email: row.email ?? '', errors, raw: row };
}

/**
 * The fields a flagged row's reasons are about, so the correction form can
 * mark them. Read from the reason's wording, which the server keeps stable;
 * a reason about two fields (an email and an Employee ID belonging to
 * different people) marks both.
 */
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

/** Whether a row gives an email or Employee ID to find the instructor by. */
export function hasIdentifier(row: ImportRow): boolean {
  return Boolean((row.email ?? '').trim() || (row.employee_id ?? '').trim());
}

/**
 * Required fields a corrected row still leaves blank. Photo Link is not among
 * them: only the server knows whether the instructor already has a photo, in
 * which case none is needed.
 */
export function blankRequiredFields(row: ImportRow): string[] {
  return IMPORT_COLUMNS
    .filter((column) => column.required && column.field !== 'photo_url' && !(row[column.field] ?? '').trim())
    .map((column) => column.label);
}

/** Lower-case letters and digits only, as the server compares values. */
function comparable(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** MALE, FEMALE or '' for a sheet's gender cell, to preselect the form. */
export function guessGender(value: string | undefined): string {
  const key = comparable(firstValue('gender', value ?? ''));
  if (['m', 'male', 'man'].includes(key)) return 'MALE';
  if (['f', 'female', 'woman'].includes(key)) return 'FEMALE';
  return '';
}

/** One of INSTRUCTOR_ROLES or '' for a sheet's role cell. */
export function guessRole(value: string | undefined): string {
  const key = comparable(firstValue('role', value ?? ''));
  return INSTRUCTOR_ROLES.find((role) => comparable(role) === key) ?? '';
}

/** The id of the institute a sheet's cell names, when exactly one matches. */
export function guessCollegeId(value: string | undefined, colleges: readonly College[]): string {
  const wanted = firstValue('institute', value ?? '');
  if (!wanted) return '';
  const byId = colleges.find((college) => String(college._id) === wanted);
  if (byId) return String(byId._id);
  const byName = colleges.filter((college) => comparable(college.name) === comparable(wanted));
  return byName.length === 1 ? String(byName[0]._id) : '';
}

/**
 * Reasons a corrected row would repeat one already in Ready, checked before
 * it is sent: the server sees one batch at a time and cannot know.
 */
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

/**
 * Keeps the first row for each email and employee ID and flags the rest.
 *
 * Checked across the whole file here because the server sees one batch at a
 * time, and two rows for the same person in different batches would both
 * pass. Emails are compared ignoring case, as the server stores them.
 */
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

/** A Google Sheets address, as opposed to any other link. */
export function isGoogleSheetLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.hostname === 'docs.google.com' && url.pathname.startsWith('/spreadsheets/');
  } catch {
    return false;
  }
}

/** "CENTRAL_INSTRUCTOR" as "Central Instructor", for the preview table. */
export function roleLabel(role: string): string {
  return role
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/** The template: every heading, and one example row showing each format. */
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

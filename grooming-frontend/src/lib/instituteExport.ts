// The Institutes page export: the rows on screen (after its filters and
// sort), with each institute's public form link.
import { csvCell } from '../attendanceExport.ts';
import type { DashboardInstitute } from '../types.ts';
import type { FormLink } from './instituteForm.ts';

function percent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '';
}

export function instituteCsv(
  rows: DashboardInstitute[],
  links: ReadonlyMap<string, FormLink>,
  origin: string,
): string {
  const columns: ReadonlyArray<[string, (row: DashboardInstitute) => unknown]> = [
    ['Institute', (row) => row.name],
    ['Present', (row) => row.present],
    ['Expected', (row) => row.expected],
    ['Present %', (row) => percent(row.present_percent)],
    ['Compliance %', (row) => percent(row.compliance_percent)],
    ['Compliant', (row) => row.compliant],
    ['Non-compliant', (row) => row.non_compliant],
    ['Instructors', (row) => row.instructors],
    ['Faces enrolled', (row) => row.enrolled],
    ['Faces enrolled %', (row) => percent(row.enrolled_percent)],
    ['Low enrolment', (row) => (row.low_enrolment ? 'Yes' : 'No')],
    ['Form link', (row) => {
      const link = links.get(row.college_id);
      return link ? `${origin}${link.path}` : '';
    }],
  ];
  const header = columns.map(([title]) => csvCell(title)).join(',');
  const lines = rows.map((row) => columns.map(([, read]) => csvCell(read(row))).join(','));
  return [header, ...lines].join('\r\n');
}

export function instituteExportFileName(from: string, to: string): string {
  if (!from && !to) return 'institutes-all.csv';
  return !to || from === to ? `institutes-${from}.csv` : `institutes-${from}_to_${to}.csv`;
}

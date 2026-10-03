import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attireSectionTitle } from '../src/reportLayout.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the abaya and the kurta are named wherever an attire type is shown', () => {
  assert.equal(attireSectionTitle('ABAYA'), '3. Attire Check (Abaya)');
  assert.equal(attireSectionTitle('KURTA_PAJAMA'), '3. Attire Check (Kurta with Payjama)');
  // The existing titles are unchanged.
  assert.equal(attireSectionTitle('SAREE'), '3. Attire Check (Saree)');
  assert.equal(attireSectionTitle('FORMAL'), '3. Attire Check');

  assert.match(source('components/DailyAttendanceTable.tsx'), /ABAYA: \{ text: 'Abaya'/);
  assert.match(source('components/DailyAttendanceTable.tsx'), /KURTA_PAJAMA: \{ text: 'Kurta \+ Payjama'/);
  assert.match(source('attendanceExport.ts'), /ABAYA: 'Abaya',\s*KURTA_PAJAMA: 'Kurta \+ Payjama'/);
  assert.match(source('components/PublicReportPage.tsx'), /ABAYA: 'Abaya',\s*KURTA_PAJAMA: 'Kurta with payjama'/);
  assert.match(source('types.ts'), /'ABAYA' \| 'KURTA_PAJAMA' \| 'UNKNOWN'/);
});

test('an abaya week shows the rotation as not applicable rather than failed', () => {
  assert.match(source('components/ReportMeta.tsx'), /NOT_APPLICABLE: \{ text: 'Not applicable \(abaya\)'/);
  assert.match(source('types.ts'), /'INSUFFICIENT_DATA' \| 'NOT_APPLICABLE'/);
});

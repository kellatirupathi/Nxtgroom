import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceCrop, hasEvidenceBoxes, validEvidenceBox } from '../src/reportLayout.ts';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('a close-up box is four numbers on a 0-1000 scale with some area', () => {
  assert.equal(validEvidenceBox([460, 293, 580, 677]), true);
  assert.equal(validEvidenceBox([580, 293, 460, 677]), false, 'upside down');
  assert.equal(validEvidenceBox([460, 293, 460, 677]), false, 'no height');
  assert.equal(validEvidenceBox([460, 293, 580, 1200]), false, 'off the scale');
  assert.equal(validEvidenceBox([460, 293, 580]), false);
  assert.equal(validEvidenceBox(null), false);
  assert.equal(validEvidenceBox(['460', 293, 580, 677]), false);
});

test('the crop places the whole photo so only the box shows, in the box\'s own shape', () => {
  // The waist band of a 960 x 1193 photograph.
  const crop = evidenceCrop([460, 293, 580, 677], 960, 1193);
  // 38.4% of the width by 12% of the height.
  assert.equal(crop.aspectRatio, '368.64 / 143.16');
  assert.equal(crop.width, '260.417%');
  assert.equal(crop.height, '833.333%');
  assert.equal(crop.left, '-76.302%');
  assert.equal(crop.top, '-383.333%');
  // The whole image: no zoom, no offset.
  assert.deepEqual(evidenceCrop([0, 0, 1000, 1000]), { ratio: 1, aspectRatio: '1 / 1', width: '100%', height: '100%', left: '0%', top: '0%' });
  assert.ok(Math.abs(crop.ratio - 368.64 / 143.16) < 1e-9);
});

test('the photo is fetched only for a report that has a close-up to show', () => {
  const row = (extra = {}) => ({ checkpoint_name: 'Belt', observation: '', status: 'FAIL', reason: '', ...extra });
  assert.equal(hasEvidenceBoxes({ attire_check: [row()] }), false);
  assert.equal(hasEvidenceBoxes({ attire_check: [row({ evidence_box: [460, 293, 580, 677] })] }), true);
  assert.equal(hasEvidenceBoxes({ footwear_check: [row({ evidence_box: [1, 2] })] }), false);
});

test('every report view hands the table its photo, and the table shows the close-up under the reason', () => {
  const report = source('components/GroomingReport.tsx');
  assert.match(report, /const wantsPhoto = Boolean\(photo\?\.path\) && hasEvidenceBoxes\(evaluation\);/);
  assert.equal((report.match(/<EvidenceCrop url=\{photoUrl\} box=\{item\.evidenceBox\} label=\{item\.evidenceLabel\} \/>/g) || []).length, 2, 'phone and desktop');
  assert.match(source('components/PublicReportPage.tsx'), /photo\/\$\{half === 'checkout' \? 'checkout' : 'checkin'\}`, auth: false \}/);
  assert.match(source('components/InstructorDetail.tsx'), /\/photo\/\$\{tab\}` \}/);
  assert.match(source('components/AuditReportModal.tsx'), /\/photo\/\$\{kind === 'checkout' \? 'checkout' : 'checkin'\}` \}/);
});

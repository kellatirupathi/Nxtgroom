import type { CheckItem, Evaluation } from './types';

/**
 * The four columns of every checkpoint table.
 *
 * Named here rather than written into the markup so the contract is one value
 * the tests can hold, instead of four table headings that could drift apart
 * between the public report and the authenticated view.
 */
export const REPORT_COLUMNS = ['Checkpoint', 'Result', 'Observation', 'Evidence'] as const;

/** Names the garment in the attire heading, so the rows below it make sense. */
export function attireSectionTitle(attireType?: string): string {
  if (attireType === 'SAREE') return '3. Attire Check (Saree)';
  if (attireType === 'KURTI_WITH_DUPATTA') return '3. Attire Check (Kurti with Dupatta)';
  if (attireType === 'ABAYA') return '3. Attire Check (Abaya)';
  if (attireType === 'KURTA_PAJAMA') return '3. Attire Check (Kurta with Payjama)';
  return '3. Attire Check';
}

export interface ReportTable {
  key: string;
  title: string;
  items: CheckItem[];
}

/**
 * The five tables, in the order the report renders them.
 *
 * The order is fixed here rather than at each call site because the same
 * evaluation is shown on the public report, the detail page and the
 * post-check-in modal, and a reader comparing two reports should never have to
 * check whether the sections moved.
 */
export function reportTables(evaluation: Evaluation): ReportTable[] {
  return [
    { key: 'general_idcard_check', title: '1. General ID Card Check', items: evaluation.general_idcard_check || [] },
    { key: 'grooming_check', title: '2. Grooming Check', items: evaluation.grooming_check || [] },
    { key: 'attire_check', title: attireSectionTitle(evaluation.attire_type), items: evaluation.attire_check || [] },
    { key: 'accessories_check', title: '4. Accessories Check', items: evaluation.accessories_check || [] },
    { key: 'footwear_check', title: '5. Footwear Check', items: evaluation.footwear_check || [] },
  ];
}

/**
 * True when the checkpoints could not meaningfully be applied, so there is
 * nothing to tabulate. Any reason counts: the sections come back empty either
 * way, and five empty tables read as checks that ran and found nothing.
 */
export function isUnassessed(evaluation: Evaluation): boolean {
  return Boolean(evaluation.unassessed_reason);
}

/**
 * The advice shown under the report.
 *
 * Supplied by the backend, which derives it from the failing checkpoints, so
 * the page and the emails cannot advise different things. An evaluation with
 * no failures yields an empty list, which the page renders as "None".
 */
export function improvementTipsFor(evaluation: Evaluation): string[] {
  return evaluation.improvement_tips || [];
}

/** Whether any row carries a close-up box, so the photo is worth fetching. */
export function hasEvidenceBoxes(evaluation: Evaluation): boolean {
  return reportTables(evaluation).some((table) => table.items.some((item) => validEvidenceBox(item.evidence_box)));
}

/** A [ymin, xmin, ymax, xmax] box on a 0-1000 scale with some area to it. */
export function validEvidenceBox(box: unknown): box is [number, number, number, number] {
  return Array.isArray(box)
    && box.length === 4
    && box.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000)
    && box[2] > box[0]
    && box[3] > box[1];
}

/**
 * How to show one area of a photograph, zoomed, in a box of its own shape:
 * the frame's aspect ratio, and where the whole image sits inside it, in
 * percentages of the frame. Without the image's own size (before it loads)
 * the photo is taken to be square, which only changes the frame's shape.
 */
export function evidenceCrop(
  box: [number, number, number, number],
  naturalWidth = 1,
  naturalHeight = 1,
): { ratio: number; aspectRatio: string; width: string; height: string; left: string; top: string } {
  const [ymin, xmin, ymax, xmax] = box.map((value) => value / 1000);
  const spanX = xmax - xmin;
  const spanY = ymax - ymin;
  const percent = (value: number) => `${Number((value * 100).toFixed(3))}%`;
  return {
    ratio: (spanX * naturalWidth) / (spanY * naturalHeight),
    aspectRatio: `${Number((spanX * naturalWidth).toFixed(3))} / ${Number((spanY * naturalHeight).toFixed(3))}`,
    width: percent(1 / spanX),
    height: percent(1 / spanY),
    left: percent(-xmin / spanX),
    top: percent(-ymin / spanY),
  };
}

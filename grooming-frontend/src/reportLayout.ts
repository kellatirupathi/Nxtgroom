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

/** True when no dress code could be applied, so there is nothing to tabulate. */
export function isUnassessed(evaluation: Evaluation): boolean {
  return evaluation.unassessed_reason === 'GENDER_NOT_CONFIGURED';
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

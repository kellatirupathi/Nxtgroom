import type { CheckItem, Evaluation } from './types';

export const REPORT_COLUMNS = ['Checkpoint', 'Result', 'Observation', 'Evidence'] as const;

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

export function reportTables(evaluation: Evaluation): ReportTable[] {
  return [
    { key: 'general_idcard_check', title: '1. General ID Card Check', items: evaluation.general_idcard_check || [] },
    { key: 'grooming_check', title: '2. Grooming Check', items: evaluation.grooming_check || [] },
    { key: 'attire_check', title: attireSectionTitle(evaluation.attire_type), items: evaluation.attire_check || [] },
    { key: 'accessories_check', title: '4. Accessories Check', items: evaluation.accessories_check || [] },
    { key: 'footwear_check', title: '5. Footwear Check', items: evaluation.footwear_check || [] },
  ];
}

export function isUnassessed(evaluation: Evaluation): boolean {
  return Boolean(evaluation.unassessed_reason);
}

export function improvementTipsFor(evaluation: Evaluation): string[] {
  return evaluation.improvement_tips || [];
}

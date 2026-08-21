import type { AttendanceRecord, Evaluation } from './types';

export type ReportHalf = 'checkin' | 'checkout';

/**
 * Identifies the evaluation by both attendance record and report half.
 * A single unkeyed value can briefly make a newly selected check-out render
 * the previous check-in's report while the check-out request is in flight.
 */
export interface EvaluationSnapshot {
  attendanceId: string;
  half: ReportHalf;
  evaluation: Evaluation | null;
}

export function evaluationForHalf(
  snapshot: EvaluationSnapshot | null,
  attendanceId: string | null,
  half: ReportHalf,
): Evaluation | null {
  if (!snapshot || !attendanceId) return null;
  return snapshot.attendanceId === attendanceId && snapshot.half === half
    ? snapshot.evaluation
    : null;
}

export function aiRemarksForHalf(
  half: ReportHalf,
  record: AttendanceRecord | null,
  evaluation: Evaluation | null,
): string | null {
  if (evaluation?.ai_summary) return evaluation.ai_summary;
  return half === 'checkout'
    ? (record?.checkout_remarks || null)
    : (record?.remarks || null);
}

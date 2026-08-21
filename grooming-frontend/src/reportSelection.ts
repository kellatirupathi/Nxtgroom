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

/**
 * One report panel's request state. Keeping one entry per half lets a user
 * switch back to a report that has already rendered without replacing it with
 * another full-screen loading state while the live copy is revalidated.
 */
export interface ReportPanelState extends EvaluationSnapshot {
  loading: boolean;
  error: string;
  settled: boolean | null;
}

export type ReportPanelStates = Partial<Record<ReportHalf, ReportPanelState>>;

export function reportPanelStateForHalf(
  states: ReportPanelStates,
  attendanceId: string | null,
  half: ReportHalf,
): ReportPanelState | null {
  if (!attendanceId) return null;
  const state = states[half];
  return state?.attendanceId === attendanceId && state.half === half ? state : null;
}

/**
 * Marks a genuinely new record/half as loading. A matching cached panel is
 * deliberately returned unchanged so a background revalidation cannot blank
 * a report that is already on screen.
 */
export function beginReportLoad(
  states: ReportPanelStates,
  attendanceId: string,
  half: ReportHalf,
): ReportPanelStates {
  if (reportPanelStateForHalf(states, attendanceId, half)) return states;
  return {
    ...states,
    [half]: {
      attendanceId,
      half,
      evaluation: null,
      loading: true,
      error: '',
      settled: null,
    },
  };
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

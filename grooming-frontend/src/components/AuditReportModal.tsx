import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, RefreshCw, TriangleAlert, X, XCircle } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import GroomingReport from './GroomingReport';
import { useToast } from './useToast';
import type { Evaluation } from '../types';

interface AuditReportModalProps {
  attendanceId: string;
  instructorName: string;
  onClose: () => void;
}

const POLL_MS = 3000;
/** Give up polling eventually so a stuck job cannot poll forever. */
const POLL_TIMEOUT_MS = 3 * 60_000;

interface StatusPayload {
  status: string;
  compliance_status: string | null;
  remarks: string | null;
  requires_human_review: boolean;
  settled: boolean;
}

function Verdict({ status }: { status: StatusPayload }) {
  if (status.requires_human_review) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">
        <CircleAlert size={14} aria-hidden="true" /> Review required
      </span>
    );
  }
  if (status.compliance_status === 'COMPLIANT') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
        <CheckCircle2 size={14} aria-hidden="true" /> Compliant
      </span>
    );
  }
  if (status.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
        <TriangleAlert size={14} aria-hidden="true" /> Analysis error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">
      <XCircle size={14} aria-hidden="true" /> Non-compliant
    </span>
  );
}

/**
 * Shows the grooming audit for a check-in without leaving the Attendance
 * screen. Opens while analysis is still running and fills in as the result
 * arrives, so the operator sees progress rather than an empty dialog.
 */
export default function AuditReportModal({ attendanceId, instructorName, onClose }: AuditReportModalProps) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [error, setError] = useState('');
  const [reanalysing, setReanalysing] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const toast = useToast();

  const loadEvaluation = useCallback(async () => {
    try {
      const data = await apiFetch<Evaluation>(
        `/api/v2/attendance/${encodeURIComponent(attendanceId)}/evaluation`,
      );
      setEvaluation(data);
    } catch {
      // A settled record without a stored evaluation is possible after an
      // analysis error; the verdict banner already explains that case.
    }
  }, [attendanceId]);

  // Follow the record until it settles, then pull the full report.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    const poll = async () => {
      if (disposed) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      try {
        const next = await apiFetch<StatusPayload>(
          `/api/v2/attendance/${encodeURIComponent(attendanceId)}/status`,
        );
        if (disposed) return;
        setStatus(next);
        if (next.settled) {
          await loadEvaluation();
          return;
        }
      } catch (requestError) {
        if (!disposed && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      }
      timer = setTimeout(poll, POLL_MS);
    };

    poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // reanalysing is in the deps so a re-run restarts the poll loop.
  }, [attendanceId, loadEvaluation, reanalysing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleReanalyse = async () => {
    setReanalysing(true);
    setError('');
    try {
      await apiJson(`/api/v2/attendance/${encodeURIComponent(attendanceId)}/reanalyse`, {
        method: 'POST',
      });
      setEvaluation(null);
      setTimedOut(false);
      setStatus({
        status: 'pending',
        compliance_status: null,
        remarks: null,
        requires_human_review: false,
        settled: false,
      });
      toast.info('Re-analysis queued', { detail: 'The same photo is being analysed again.' });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not start re-analysis', { detail: message });
    } finally {
      setReanalysing(false);
    }
  };

  const running = !status?.settled && !timedOut;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-report-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-md bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/60 px-5 py-4">
          <div className="min-w-0">
            <h2 id="audit-report-title" className="text-lg font-extrabold text-slate-800">
              Detailed Grooming Audit Report
            </h2>
            <p className="mt-0.5 truncate text-sm text-slate-500">{instructorName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {status && !running && <Verdict status={status} />}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close report"
              className="-m-1 rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
              {error}
            </div>
          )}

          {running && (
            <div className="flex flex-col items-center justify-center py-14 text-center" role="status">
              <Loader2 size={32} className="animate-spin text-indigo-600" aria-hidden="true" />
              <p className="mt-4 text-sm font-bold text-slate-700">Analysing the check-in photo…</p>
              <p className="mt-1 text-xs text-slate-500">
                This usually takes a few seconds. You can close this and the analysis will continue.
              </p>
            </div>
          )}

          {timedOut && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              Analysis is taking longer than usual. It will finish in the background — check Daily
              Records shortly, or try Re-analyse.
            </div>
          )}

          {!running && status?.remarks && (
            <p className="mb-5 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              {status.remarks}
            </p>
          )}

          {!running && evaluation && <GroomingReport evaluation={evaluation} />}

          {!running && !evaluation && !timedOut && (
            <p className="py-6 text-center text-sm text-slate-500">
              No checkpoint detail was stored for this analysis.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleReanalyse}
            disabled={reanalysing || running}
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            <RefreshCw size={15} className={reanalysing ? 'animate-spin' : ''} aria-hidden="true" />
            {reanalysing ? 'Queueing…' : 'Re-analyse'}
          </button>
        </div>
      </div>
    </div>
  );
}

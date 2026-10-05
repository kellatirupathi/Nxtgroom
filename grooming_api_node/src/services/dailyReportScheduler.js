import { createHash } from "node:crypto";
import { enqueueMailJob } from "./mailWorker.js";
import { localDateKey } from "./instructorReports.js";
import {
  buildDailyReportForEmail,
  campusIdsInReport,
  dailyReportRunId,
  dueDailyReports,
  ensureDailyReportDay,
  getDailyReportSettings,
} from "./dailyReport.js";
import { getDeliveryRun, saveDeliveryRun } from "../stores/deliveryRunStore.js";

const TICK_MS = 30_000;
const FIRST_TICK_MS = 5_000;

function recipientKey(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 20);
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

export async function runDueDailyReports(db, now = new Date(), { queuedRuns = new Set() } = {}) {
  const settings = await getDailyReportSettings(db);
  if (!settings.enabled || !settings.emails.length) return [];

  const queued = [];
  for (const due of dueDailyReports(settings, now)) {
    const runId = dailyReportRunId(due.dateKey, due.slot);
    if (queuedRuns.has(runId)) continue;
    const existing = await getDeliveryRun(db, runId);
    if (existing?.jobs_queued_at) {
      queuedRuns.add(runId);
      continue;
    }

    await ensureDailyReportDay(db, due.dateKey, now);
    let campusIds = [];
    if (!existing && settings.campus_reports) {
      const draft = { _id: runId, date: due.dateKey, slot: due.slot, window_from: due.from, window_to: due.to };
      campusIds = campusIdsInReport(await buildDailyReportForEmail(db, draft, now.getTime()));
    }
    try {
      await saveDeliveryRun(db, runId, {
        set: { updated_at: now },
        setOnInsert: {
          _id: runId,
          type: "daily_report",
          date: due.dateKey,
          slot: due.slot,
          window_from: due.from,
          window_to: due.to,
          status: "sending",
          ...(settings.campus_reports ? { campus_ids: campusIds } : {}),
          queued: settings.emails.length * (1 + campusIds.length),
          sent: 0,
          failed: 0,
          terminal: 0,
          created_at: now,
        },
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    const run = await getDeliveryRun(db, runId);
    if (!run) throw new Error(`Daily report run ${runId} could not be read back`);

    for (const email of settings.emails) {
      await enqueueMailJob(db, {
        id: `${runId}:${recipientKey(email)}`,
        type: "daily_report",
        toEmail: email,
        payload: { run_id: runId },
        runId,
      });
    }
    const runCampuses = Array.isArray(run.campus_ids) ? run.campus_ids : [];
    for (const collegeId of runCampuses) {
      for (const email of settings.emails) {
        await enqueueMailJob(db, {
          id: `${runId}:campus:${collegeId}:${recipientKey(email)}`,
          type: "daily_report_campus",
          toEmail: email,
          payload: { run_id: runId, college_id: collegeId },
          runId,
        });
      }
    }
    await saveDeliveryRun(db, runId, { set: { jobs_queued_at: now, updated_at: now } });
    queuedRuns.add(runId);
    queued.push(runId);
    console.log(`Daily report ${runId} queued for ${settings.emails.length} recipient(s)${runCampuses.length ? `, with ${runCampuses.length} institute report(s)` : ""}.`);
  }
  return queued;
}

export function startDailyReportScheduler(db, { intervalMs = TICK_MS, firstTickMs = FIRST_TICK_MS } = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  let queuedRuns = new Set();
  let queuedDay = null;

  const tick = () => {
    inFlight = (async () => {
      try {
        const now = new Date();
        const day = localDateKey(now);
        if (day !== queuedDay) {
          queuedRuns = new Set();
          queuedDay = day;
        }
        await runDueDailyReports(db, now, { queuedRuns });
      } catch (error) {
        console.error(`Daily report scheduler error (${String(error?.code || error?.name || "Error")})`);
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    })();
  };

  timer = setTimeout(tick, firstTickMs);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

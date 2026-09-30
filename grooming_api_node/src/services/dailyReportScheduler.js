import { createHash } from "node:crypto";
import { enqueueMailJob } from "./mailWorker.js";
import { localDateKey } from "./instructorReports.js";
import {
  dailyReportRunId,
  dueDailyReports,
  ensureDailyReportDay,
  getDailyReportSettings,
} from "./dailyReport.js";
import { getDeliveryRun, saveDeliveryRun } from "../stores/deliveryRunStore.js";

/**
 * Sends each daily report once, at its time.
 *
 * Runs inside the server rather than from an outside scheduler, because the
 * send times are chosen on the settings screen and change without anybody
 * touching cron. Checking every half minute puts a report in the inbox within
 * a minute of its time.
 *
 * Exactly once, even with a restart or two servers: the run document is keyed
 * by date and time and created only if absent, every email job id is derived
 * from the run and the recipient, and a run is marked as queued only after all
 * of its jobs exist. A server that was down at the send time sends the report
 * when it comes back, the same day.
 */

const TICK_MS = 30_000;
const FIRST_TICK_MS = 5_000;

function recipientKey(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 20);
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

/**
 * Queues every report that is due and not yet queued. Returns the run ids it
 * queued. `queuedRuns` remembers finished runs within one day, so a quiet
 * tick costs one settings read.
 */
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

    // The day's page exists before any email linking to it is queued.
    await ensureDailyReportDay(db, due.dateKey, now);
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
          queued: settings.emails.length,
          sent: 0,
          failed: 0,
          terminal: 0,
          created_at: now,
        },
      });
    } catch (error) {
      // Another server created the same run in the same instant.
      if (!isDuplicateKey(error)) throw error;
    }
    // The stored run is authoritative: its period is the one the emails use,
    // whoever created it.
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
    await saveDeliveryRun(db, runId, { set: { jobs_queued_at: now, updated_at: now } });
    queuedRuns.add(runId);
    queued.push(runId);
    console.log(`Daily report ${runId} queued for ${settings.emails.length} recipient(s).`);
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

/**
 * How often the durable workers touch the database while there is nothing to
 * do.
 *
 * Every poll runs several queries even on an empty queue, and the four
 * workers used to poll every two seconds all day: about nine operations a
 * second per server, most of the Atlas M0 budget of 100, before a single
 * instructor checked in. New work does not need a fast poll to be noticed:
 * the code that queues a job wakes its worker in the same process. Polling
 * is only the safety net for retries that come due, expired leases, and jobs
 * queued by another process (PROCESS_ROLE=api with a separate worker).
 */

/**
 * Delay before the next poll: none after a cycle that found work, otherwise
 * doubling from minMs up to maxMs, so a quiet worker settles at maxMs and a
 * busy one drains its queue without waiting.
 *
 * maxMs must stay well below the heartbeat staleness window in
 * workerHealth.js (60 s), which idle cycles keep fresh.
 */
export function createIdleBackoff({ minMs, maxMs }) {
  const floor = Math.max(0, minMs);
  const ceiling = Math.max(floor, maxMs);
  let next = floor;
  return {
    afterCycle(foundWork) {
      if (foundWork) {
        next = floor;
        return 0;
      }
      const delay = next;
      next = Math.min(ceiling, Math.max(1, next) * 2);
      return delay;
    },
    reset() {
      next = floor;
    },
  };
}

/**
 * Recovery sweeps (outbox reconciliation, overdue deadlines, expired leases,
 * unsynced outcomes) only catch what a crash or a lost wake-up left behind.
 * Leases last minutes and deadlines a day, so running them on every poll
 * bought nothing but queries. due() is true on the first call and then at
 * most once per intervalMs.
 */
export function createSweepSchedule(intervalMs, now = Date.now) {
  let lastRunAt = null;
  return {
    due() {
      const current = now();
      if (lastRunAt !== null && current - lastRunAt < intervalMs) return false;
      lastRunAt = current;
      return true;
    },
  };
}

/**
 * In-process wake-up for a worker, best-effort by design: when the API and
 * the workers run as separate processes nobody is listening, and the idle
 * poll still picks the job up within maxMs.
 */
export function createWakeSignal() {
  const listeners = new Set();
  return {
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A wake-up is an optimisation. The poll still covers this job.
        }
      }
    },
  };
}

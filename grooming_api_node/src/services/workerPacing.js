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
        }
      }
    },
  };
}

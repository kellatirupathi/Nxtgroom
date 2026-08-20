const counters = new Map();
const durations = new Map();

export function incrementMetric(name, amount = 1) {
  counters.set(name, (counters.get(name) || 0) + amount);
}

export function observeDuration(name, milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return;
  const current = durations.get(name) || { count: 0, total_ms: 0, max_ms: 0 };
  current.count += 1;
  current.total_ms += value;
  current.max_ms = Math.max(current.max_ms, value);
  durations.set(name, current);
}

export function telemetrySnapshot() {
  return {
    counters: Object.fromEntries(counters),
    durations: Object.fromEntries([...durations].map(([name, value]) => [name, {
      count: value.count,
      average_ms: value.count ? Math.round(value.total_ms / value.count) : 0,
      max_ms: Math.round(value.max_ms),
    }])),
  };
}

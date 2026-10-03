import { runtimeConfig } from "../config/env.js";

export const NOON_HOUR = 12;

export const AFTERNOON_MINIMUM_MS = 5 * 60_000;

export const CHECKOUT_TIMING = Object.freeze({
  ALLOWED: "allowed",
  TOO_EARLY: "too_early",
});

function localParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
}

function localNoonOn(reference, timeZone) {
  const { year, month, day } = localParts(reference, timeZone);
  const target = Date.UTC(year, month - 1, day, NOON_HOUR, 0, 0);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localParts(new Date(candidate), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const drift = target - asUtc;
    if (drift === 0) break;
    candidate += drift;
  }
  return new Date(candidate);
}

export function checkoutTiming(checkInTime, { now = new Date(), timeZone = runtimeConfig().appTimeZone } = {}) {
  const hasValue = checkInTime instanceof Date
    || (typeof checkInTime === "string" && checkInTime.trim() !== "")
    || typeof checkInTime === "number";
  const checkedInAt = hasValue ? new Date(checkInTime) : new Date(NaN);
  if (Number.isNaN(checkedInAt.getTime())) {
    return { state: CHECKOUT_TIMING.ALLOWED, opens_at: null, rule: "unknown_check_in_time" };
  }

  const noon = localNoonOn(checkedInAt, timeZone);
  const beforeNoon = checkedInAt.getTime() < noon.getTime();
  const opensAt = beforeNoon
    ? noon
    : new Date(checkedInAt.getTime() + AFTERNOON_MINIMUM_MS);
  const rule = beforeNoon ? "morning_waits_for_noon" : "afternoon_waits_five_minutes";

  if (now.getTime() >= opensAt.getTime()) {
    return { state: CHECKOUT_TIMING.ALLOWED, opens_at: opensAt, rule };
  }
  return {
    state: CHECKOUT_TIMING.TOO_EARLY,
    opens_at: opensAt,
    rule,
    minutes_remaining: Math.max(1, Math.ceil((opensAt.getTime() - now.getTime()) / 60_000)),
  };
}

export function describeCheckoutTiming(timing, { timeZone = runtimeConfig().appTimeZone } = {}) {
  if (timing.state === CHECKOUT_TIMING.ALLOWED) return null;
  const opensAtLabel = new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(timing.opens_at);
  return timing.rule === "morning_waits_for_noon"
    ? `Already checked in this morning. Check-out opens at ${opensAtLabel}.`
    : `Already checked in. Check-out opens at ${opensAtLabel}, about ${timing.minutes_remaining} minute${timing.minutes_remaining === 1 ? "" : "s"} from now.`;
}

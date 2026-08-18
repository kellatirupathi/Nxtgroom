import { randomUUID } from "node:crypto";

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createDocument(values) {
  return { _id: randomUUID(), ...values };
}

export function serializeDocument(document) {
  if (!document) return document;
  return { ...document, _id: String(document._id) };
}

export function todayBounds(offsetMinutes = 330, now = new Date()) {
  const offsetMs = offsetMinutes * 60_000;
  const shifted = new Date(now.getTime() + offsetMs);
  const shiftedStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  const start = new Date(shiftedStart - offsetMs);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function zonedParts(value, timeZone) {
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
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function timeZoneOffsetMs(timestamp, timeZone) {
  const wholeSecondTimestamp = Math.floor(timestamp / 1000) * 1000;
  const parts = zonedParts(new Date(wholeSecondTimestamp), timeZone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ) - wholeSecondTimestamp;
}

function localMidnightUtc({ year, month, day }, timeZone) {
  const desiredLocalTimestamp = Date.UTC(year, month - 1, day);
  let candidate = desiredLocalTimestamp;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const adjusted = desiredLocalTimestamp - timeZoneOffsetMs(candidate, timeZone);
    if (adjusted === candidate) break;
    candidate = adjusted;
  }
  const resolved = new Date(candidate);
  const parts = zonedParts(resolved, timeZone);
  if (
    parts.year !== year
    || parts.month !== month
    || parts.day !== day
    || parts.hour !== 0
    || parts.minute !== 0
  ) {
    throw new RangeError("The requested local date has no valid midnight in APP_TIME_ZONE");
  }
  return resolved;
}

function parseCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("date must use YYYY-MM-DD format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999) throw new RangeError("date year must be between 1000 and 9999");
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year
    || calendarCheck.getUTCMonth() !== month - 1
    || calendarCheck.getUTCDate() !== day
  ) {
    throw new RangeError("date must be a real calendar date");
  }
  return { year, month, day };
}

/** Returns the UTC boundaries of one calendar day in an IANA time zone. */
export function dateBoundsInTimeZone(dateValue, timeZone, now = new Date()) {
  if (dateValue !== undefined && typeof dateValue !== "string") {
    throw new RangeError("date must be provided only once in YYYY-MM-DD format");
  }
  const localDate = dateValue === undefined
    ? (() => {
        const parts = zonedParts(now, timeZone);
        return { year: parts.year, month: parts.month, day: parts.day };
      })()
    : parseCalendarDate(dateValue);
  const nextCalendarDate = new Date(Date.UTC(
    localDate.year,
    localDate.month - 1,
    localDate.day + 1
  ));
  return {
    start: localMidnightUtc(localDate, timeZone),
    end: localMidnightUtc({
      year: nextCalendarDate.getUTCFullYear(),
      month: nextCalendarDate.getUTCMonth() + 1,
      day: nextCalendarDate.getUTCDate(),
    }, timeZone),
  };
}

/**
 * Bounds covering whole local days from `from` to `to`, both inclusive.
 *
 * Built from calendar dates rather than timestamps because a day means a day
 * where the instructor is, not a 24-hour window from whenever the request was
 * made: a check-in at 00:30 in Asia/Kolkata belongs to that date, not the one
 * before it in UTC.
 *
 * Either end may be omitted to leave that side open, which is what "all time"
 * and open-ended ranges use.
 */
export function dateRangeBoundsInTimeZone(from, to, timeZone) {
  for (const [name, value] of [["from", from], ["to", to]]) {
    if (value !== undefined && typeof value !== "string") {
      throw new RangeError(`${name} must be provided only once in YYYY-MM-DD format`);
    }
  }

  const start = from === undefined
    ? null
    : localMidnightUtc(parseCalendarDate(from), timeZone);

  let end = null;
  if (to !== undefined) {
    // The day after `to` at local midnight, so the final day is included in
    // full rather than truncated at 00:00.
    const parsed = parseCalendarDate(to);
    const dayAfter = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
    end = localMidnightUtc({
      year: dayAfter.getUTCFullYear(),
      month: dayAfter.getUTCMonth() + 1,
      day: dayAfter.getUTCDate(),
    }, timeZone);
  }

  if (start && end && start >= end) {
    throw new RangeError("from must be on or before to");
  }
  return { start, end };
}

function parseCanonicalPageInteger(value, name, { minimum, maximum, fallback }) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new RangeError(`${name} must be provided only once as a whole number`);
  }
  const canonicalPattern = minimum === 0 ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!canonicalPattern.test(value)) {
    throw new RangeError(`${name} must be a whole number between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be a whole number between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/** Strict offset pagination for array-returning endpoints. */
export function parsePagination(
  query,
  { defaultLimit, maxLimit, maxOffset = 1_000_000 }
) {
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > maxLimit) {
    throw new TypeError("defaultLimit must be within the configured page limit");
  }
  if (!Number.isSafeInteger(maxLimit) || maxLimit < 1) {
    throw new TypeError("maxLimit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOffset) || maxOffset < 0) {
    throw new TypeError("maxOffset must be a non-negative safe integer");
  }
  return {
    limit: parseCanonicalPageInteger(query?.limit, "limit", {
      minimum: 1,
      maximum: maxLimit,
      fallback: defaultLimit,
    }),
    offset: parseCanonicalPageInteger(query?.offset, "offset", {
      minimum: 0,
      maximum: maxOffset,
      fallback: 0,
    }),
  };
}

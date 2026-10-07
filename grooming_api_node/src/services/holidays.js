import { getSetting, saveSetting } from "../stores/settingsStore.js";
import { isValidDateKey } from "./instructorReports.js";

export const HOLIDAY_SETTINGS_ID = "holiday_settings";
export const MAX_HOLIDAY_NAME = 80;
const CACHE_MS = 60_000;
let cache = null;

export function clearHolidayCache() {
  cache = null;
}

function cleanList(values) {
  const byDate = new Map();
  for (const item of Array.isArray(values) ? values : []) {
    if (!item || !isValidDateKey(item.date)) continue;
    const name = typeof item.name === "string" ? item.name.trim().replace(/\s+/g, " ").slice(0, MAX_HOLIDAY_NAME) : "";
    byDate.set(item.date, { date: item.date, name });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export async function listHolidays(db, { now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_MS) return cache.holidays;
  let stored = null;
  try {
    stored = await getSetting(db, HOLIDAY_SETTINGS_ID);
  } catch (error) {
    console.error(`Holiday list could not be read (${error?.name || "Error"}); treating today as a working day`);
    return [];
  }
  const holidays = cleanList(stored?.holidays);
  cache = { at: now, holidays };
  return holidays;
}

export async function holidayDates(db) {
  return new Set((await listHolidays(db)).map((holiday) => holiday.date));
}

export async function isHoliday(db, dateKey) {
  return (await holidayDates(db)).has(dateKey);
}

async function save(db, holidays, updatedBy) {
  const now = new Date();
  await saveSetting(db, HOLIDAY_SETTINGS_ID, {
    set: { holidays, updated_at: now, updated_by: updatedBy || null },
    setOnInsert: { _id: HOLIDAY_SETTINGS_ID, created_at: now },
  });
  clearHolidayCache();
  return listHolidays(db);
}

export function validateHoliday(body) {
  const date = typeof body?.date === "string" ? body.date.trim() : "";
  if (!isValidDateKey(date)) return { ok: false, detail: "Choose a valid date." };
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, detail: "Enter the holiday's name." };
  if (name.length > MAX_HOLIDAY_NAME) return { ok: false, detail: `Use at most ${MAX_HOLIDAY_NAME} characters.` };
  return { ok: true, holiday: { date, name } };
}

export async function addHoliday(db, body, updatedBy = null) {
  const check = validateHoliday(body);
  if (!check.ok) return check;
  clearHolidayCache();
  const current = await listHolidays(db);
  if (current.some((holiday) => holiday.date === check.holiday.date)) {
    return { ok: false, detail: "That date is already a holiday." };
  }
  return { ok: true, holidays: await save(db, cleanList([...current, check.holiday]), updatedBy) };
}

export async function removeHoliday(db, date, updatedBy = null) {
  clearHolidayCache();
  const current = await listHolidays(db);
  if (!current.some((holiday) => holiday.date === date)) return { ok: false, detail: "Holiday not found." };
  return { ok: true, holidays: await save(db, current.filter((holiday) => holiday.date !== date), updatedBy) };
}

// Helpdesk 1.19.0 (calendars, agent L): the calendar-aware business-hours
// arithmetic gives exactly what the single-window implementation it
// replaced gave, for legacy (helpdesk_settings-shaped) hours. The old code
// is frozen below, verbatim; a battery of instants, minute counts, zones,
// windows and holidays runs through both. Pure, no database.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-calendars-regression.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addBusinessMinutes, businessMinutesBetween, inBusinessHours, wallClock, zonedInstant } from "../src/lib/helpdesk/sla";
import { hoursFromCalendar, scheduleFromLegacy } from "../src/lib/helpdesk/calendars-shared";
import type { HdBusinessHours } from "../src/lib/helpdesk/types";

const MIN = 60_000;
const DAY_MS = 86_400_000;

// --- The 1.19.0-pre single-window implementation, frozen ---------------------------
const old = (() => {
function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function hm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h || 0, m || 0];
}

/** The calendar date after y-m-d (pure Gregorian arithmetic, no zone). */
function nextDate(y: number, m: number, d: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d) + DAY_MS);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function dowOf(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** The business window [open, close) of local date y-m-d, or null if it is not a working day. */
function windowFor(y: number, m: number, d: number, hours: HdBusinessHours): [number, number] | null {
  if (!hours.days.includes(dowOf(y, m, d))) return null;
  if (hours.holidays.includes(ymd(y, m, d))) return null;
  const [sh, sm] = hm(hours.start);
  const [eh, em] = hm(hours.end);
  const open = zonedInstant(y, m, d, sh, sm, hours.timezone);
  const close = zonedInstant(y, m, d, eh, em, hours.timezone);
  return close > open ? [open, close] : null;
}

/** No working day at all (empty days, or start ≥ end): business arithmetic falls back to calendar time. */
function noBusinessTime(hours: HdBusinessHours): boolean {
  const [sh, sm] = hm(hours.start);
  const [eh, em] = hm(hours.end);
  return hours.days.length === 0 || eh * 60 + em <= sh * 60 + sm;
}

/** Days scanned before giving up (holidays every day for years is a config error). */
const MAX_SCAN_DAYS = 3 * 366;

/**
 * The instant `minutes` business minutes after `from`. Time outside the
 * window, on non-working days and on holidays does not count; a start
 * outside hours begins counting at the next opening. 0 minutes from outside
 * hours is the next opening.
 */
function addBusinessMinutes(from: Date | number, minutes: number, hours: HdBusinessHours): Date {
  const start = typeof from === "number" ? from : from.getTime();
  if (noBusinessTime(hours)) return new Date(start + minutes * MIN);
  let remaining = Math.max(0, minutes) * MIN;
  const w = wallClock(start, hours.timezone);
  let [y, m, d] = [w.y, w.m, w.d];
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const win = windowFor(y, m, d, hours);
    if (win) {
      const [open, close] = win;
      const from0 = Math.max(open, start);
      if (from0 < close) {
        const avail = close - from0;
        if (remaining <= avail) return new Date(from0 + remaining);
        remaining -= avail;
      }
    }
    [y, m, d] = nextDate(y, m, d);
  }
  return new Date(start + minutes * MIN);
}

/** Business minutes between two instants (0 when b ≤ a). */
function businessMinutesBetween(a: Date | number, b: Date | number, hours: HdBusinessHours): number {
  const ta = typeof a === "number" ? a : a.getTime();
  const tb = typeof b === "number" ? b : b.getTime();
  if (tb <= ta) return 0;
  if (noBusinessTime(hours)) return (tb - ta) / MIN;
  let total = 0;
  const w = wallClock(ta, hours.timezone);
  let [y, m, d] = [w.y, w.m, w.d];
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const win = windowFor(y, m, d, hours);
    if (win) {
      const [open, close] = win;
      if (open >= tb) break;
      const lo = Math.max(open, ta);
      const hi = Math.min(close, tb);
      if (hi > lo) total += hi - lo;
    } else {
      // A non-working day past the end: stop once its midnight is past tb.
      const mid = zonedInstant(y, m, d, 0, 0, hours.timezone);
      if (mid >= tb) break;
    }
    [y, m, d] = nextDate(y, m, d);
  }
  return total / MIN;
}

/** Inside a business window right now? */
function inBusinessHours(t: Date | number, hours: HdBusinessHours): boolean {
  const ts = typeof t === "number" ? t : t.getTime();
  if (noBusinessTime(hours)) return true;
  const w = wallClock(ts, hours.timezone);
  const win = windowFor(w.y, w.m, w.d, hours);
  return !!win && ts >= win[0] && ts < win[1];
}
  return { addBusinessMinutes, businessMinutesBetween, inBusinessHours };
})();

// --- The battery ---------------------------------------------------------------------

/** A small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const HOURS: HdBusinessHours[] = [
  { timezone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", holidays: [] },
  { timezone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", holidays: ["2026-12-25", "2026-12-28", "2027-01-01", "2026-03-30", "2026-11-09"] },
  { timezone: "America/New_York", days: [1, 2, 3, 4, 5], start: "08:30", end: "17:00", holidays: ["2026-11-26", "2026-07-03"] },
  { timezone: "Asia/Tokyo", days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00", holidays: [] },
  { timezone: "Australia/Sydney", days: [1, 2, 3, 4], start: "07:00", end: "15:15", holidays: ["2026-04-06"] },
  { timezone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "23:59", holidays: [] },
  { timezone: "Europe/Berlin", days: [2, 4], start: "01:30", end: "03:30", holidays: [] },
  // No working time: both fall back to calendar time.
  { timezone: "Europe/London", days: [], start: "09:00", end: "17:30", holidays: [] },
];

const r = rng(20261106);
const START = Date.parse("2025-12-20T00:00:00Z");
const SPAN = 470 * DAY_MS; // across both 2026 DST changes and two year ends
const MINUTES = [0, 1, 15, 59, 60, 61, 240, 510, 1020, 1440, 3000, 10_000];

describe("legacy hours give the old results", () => {
  for (const [i, hours] of HOURS.entries()) {
    test(`hours #${i} (${hours.timezone} ${hours.start}–${hours.end}, days ${hours.days.join("")})`, () => {
      for (let k = 0; k < 160; k++) {
        // Instants on the minute, on exact window edges and in between.
        let t = START + Math.floor(r() * SPAN / MIN) * MIN;
        if (k % 5 === 0) {
          const w = wallClock(t, hours.timezone);
          const [h, m] = (k % 10 === 0 ? hours.start : hours.end).split(":").map(Number);
          t = zonedInstant(w.y, w.m, w.d, h, m, hours.timezone);
        }
        const mins = MINUTES[k % MINUTES.length] + (k % 3 === 0 ? 0.5 : 0);
        assert.equal(addBusinessMinutes(t, mins, hours).getTime(), old.addBusinessMinutes(t, mins, hours).getTime(), `add ${new Date(t).toISOString()} +${mins}`);
        const b = t + Math.floor(r() * 20 * DAY_MS);
        assert.equal(businessMinutesBetween(t, b, hours), old.businessMinutesBetween(t, b, hours), `between ${new Date(t).toISOString()} → ${new Date(b).toISOString()}`);
        assert.equal(inBusinessHours(t, hours), old.inBusinessHours(t, hours), `in ${new Date(t).toISOString()}`);
      }
    });
  }

  test("the migrated calendar (schedule form) agrees with the old window too", () => {
    for (const hours of HOURS.slice(0, 5)) {
      const cal = hoursFromCalendar(
        { id: 1, name: "Office hours", timezone: hours.timezone, schedule: scheduleFromLegacy(hours.days, hours.start, hours.end) },
        hours.holidays.map((date) => ({ date, name: "Holiday", recurring_yearly: false, closed_from: null, closed_to: null }))
      );
      for (let k = 0; k < 120; k++) {
        const t = START + Math.floor(r() * SPAN / MIN) * MIN;
        const mins = MINUTES[k % MINUTES.length];
        assert.equal(addBusinessMinutes(t, mins, cal).getTime(), old.addBusinessMinutes(t, mins, hours).getTime(), `${hours.timezone} add ${new Date(t).toISOString()} +${mins}`);
        const b = t + Math.floor(r() * 15 * DAY_MS);
        assert.equal(businessMinutesBetween(t, b, cal), old.businessMinutesBetween(t, b, hours));
        assert.equal(inBusinessHours(t, cal), old.inBusinessHours(t, hours));
      }
    }
  });
});

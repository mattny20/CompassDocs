// Helpdesk 1.19.0 (calendars, agent L): the calendar arithmetic in
// lib/helpdesk/sla and the words around it in lib/helpdesk/calendars-shared.
// Split shifts, 24/7, shifts across midnight, DST in Europe/London and
// America/New_York, whole / partial / yearly holidays, a holiday on a
// weekend, the no-open-hours guard, a year boundary; the preview's
// explanation, the queue's clock note, the requester's open state; the
// paste and .ics parsers; schedule validation and summaries. Pure.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-calendars-math.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HD_NO_OPEN_HOURS_DUE, addBusinessMinutes, businessMinutesBetween, hasOpenHours, inBusinessHours, nextOpening } from "../src/lib/helpdesk/sla";
import {
  clockNoteWith,
  explainDue,
  hoursFromCalendar,
  openStateWith,
  parseHolidayLines,
  parseIcs,
  summarizeSchedule,
  validateSchedule,
} from "../src/lib/helpdesk/calendars-shared";
import type { HdHoliday, HdWeekSchedule } from "../src/lib/helpdesk/calendars-shared";
import type { HdTimeInterval } from "../src/lib/helpdesk/types";

const at = (s: string) => Date.parse(s);
const iso = (t: Date | number) => new Date(t).toISOString();

/** A week: the same intervals Monday–Friday (index 1–5), weekend closed unless given. */
function week(weekday: HdTimeInterval[], weekend: HdTimeInterval[] = []): HdWeekSchedule {
  return [weekend, weekday, weekday, weekday, weekday, weekday, weekend];
}
type H = Pick<HdHoliday, "date" | "name" | "recurring_yearly" | "closed_from" | "closed_to">;
const hol = (date: string, name: string, extra: Partial<H> = {}): H => ({ date, name, recurring_yearly: false, closed_from: null, closed_to: null, ...extra });
function cal(timezone: string, schedule: HdWeekSchedule, holidays: H[] = []) {
  return hoursFromCalendar({ id: 1, name: "Test", timezone, schedule }, holidays);
}

const OFFICE = [{ start: "09:00", end: "17:30" }];
const LONDON = cal("Europe/London", week(OFFICE));
const ALL_DAY = { start: "00:00", end: "24:00" };
const ALWAYS = (tz: string) => cal(tz, [[ALL_DAY], [ALL_DAY], [ALL_DAY], [ALL_DAY], [ALL_DAY], [ALL_DAY], [ALL_DAY]]);

describe("intervals", () => {
  test("split shift: the lunch hour does not count", () => {
    const split = cal("Europe/London", week([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }]));
    // Mon 9 Nov 11:30 GMT + 60 → 30 before lunch, 30 after → 13:30.
    assert.equal(iso(addBusinessMinutes(at("2026-11-09T11:30:00Z"), 60, split)), "2026-11-09T13:30:00.000Z");
    assert.equal(inBusinessHours(at("2026-11-09T12:30:00Z"), split), false);
    assert.equal(businessMinutesBetween(at("2026-11-09T07:00:00Z"), at("2026-11-09T18:00:00Z"), split), 480);
  });

  test("24/7 counts real elapsed time, across DST changes", () => {
    const lon = ALWAYS("Europe/London");
    // Spring forward on Sun 29 Mar 2026: still 24 real hours.
    assert.equal(iso(addBusinessMinutes(at("2026-03-28T12:00:00Z"), 1440, lon)), "2026-03-29T12:00:00.000Z");
    assert.equal(businessMinutesBetween(at("2026-03-28T00:00:00Z"), at("2026-03-30T00:00:00Z"), lon), 2880);
    const ny = ALWAYS("America/New_York");
    // Fall back on Sun 1 Nov 2026.
    assert.equal(iso(addBusinessMinutes(at("2026-10-31T16:00:00Z"), 1440, ny)), "2026-11-01T16:00:00.000Z");
    assert.equal(inBusinessHours(at("2026-11-01T06:30:00Z"), ny), true);
    assert.equal(iso(addBusinessMinutes(at("2026-11-06T16:30:00Z"), 3000, lon)), iso(at("2026-11-06T16:30:00Z") + 3000 * 60_000));
  });

  test("a shift across midnight belongs to the day it starts", () => {
    // Night desk Mon–Fri 22:00–06:00 New York (EST in November: 03:00Z–11:00Z).
    const night = cal("America/New_York", week([{ start: "22:00", end: "06:00" }]));
    // Tue 10 Nov 05:00 EST (10:00Z) is inside Monday's shift; +120 → 60 to 06:00, 60 from Tue 22:00 → 23:00 EST.
    assert.equal(inBusinessHours(at("2026-11-10T10:00:00Z"), night), true);
    assert.equal(iso(addBusinessMinutes(at("2026-11-10T10:00:00Z"), 120, night)), "2026-11-11T04:00:00.000Z");
    // Friday's shift runs into Saturday morning; Saturday's own (none) does not.
    // Fri 13 Nov 22:00 EST (14 Nov 03:00Z) → Sat 06:00: 480; nothing more before Monday night.
    assert.equal(businessMinutesBetween(at("2026-11-14T03:00:00Z"), at("2026-11-16T12:00:00Z"), night), 480);
  });

  test("a holiday closes its own date, even the part of last night's shift on it", () => {
    const night = cal("America/New_York", week([{ start: "22:00", end: "06:00" }]), [hol("2026-11-11", "Veterans Day")]);
    // Tue 10 Nov 22:00 → Wed 06:00: only the two hours before midnight count.
    assert.equal(businessMinutesBetween(at("2026-11-11T03:00:00Z"), at("2026-11-11T11:00:00Z"), night), 120);
  });

  test("an overnight shift on the spring-forward night is an hour shorter", () => {
    const night = cal("Europe/London", [[{ start: "22:00", end: "06:00" }], [], [], [], [], [], [{ start: "22:00", end: "06:00" }]]);
    // Sat 28 Mar 22:00 GMT → Sun 29 Mar 06:00 BST = 05:00Z: 7 real hours.
    assert.equal(businessMinutesBetween(at("2026-03-28T20:00:00Z"), at("2026-03-29T12:00:00Z"), night), 420);
  });
});

describe("daylight saving", () => {
  test("Europe/London autumn: Friday in BST, Monday in GMT", () => {
    // Fri 23 Oct 16:30 BST (15:30Z) + 120 → 60 on Friday, Mon 26 Oct 09:00 GMT + 60 → 10:00Z.
    assert.equal(iso(addBusinessMinutes(at("2026-10-23T15:30:00Z"), 120, LONDON)), "2026-10-26T10:00:00.000Z");
  });
  test("America/New_York spring: Friday in EST, Monday in EDT", () => {
    const ny = cal("America/New_York", week([{ start: "09:00", end: "17:00" }]));
    // Fri 6 Mar 16:00 EST (21:00Z) + 120 → Mon 9 Mar 09:00 EDT (13:00Z) + 60 → 14:00Z.
    assert.equal(iso(addBusinessMinutes(at("2026-03-06T21:00:00Z"), 120, ny)), "2026-03-09T14:00:00.000Z");
    assert.equal(businessMinutesBetween(at("2026-03-06T21:00:00Z"), at("2026-03-09T14:00:00Z"), ny), 120);
  });
});

describe("holidays", () => {
  test("whole day, partial day, and a year boundary", () => {
    const xmas = cal("Europe/London", week(OFFICE), [
      hol("2026-12-24", "Christmas Eve", { closed_from: "13:00" }),
      hol("2026-12-25", "Christmas Day"),
      hol("2027-01-01", "New Year's Day"),
    ]);
    // Thu 24 Dec 12:30 + 60 → 30 until 13:00, Christmas Day closed, weekend → Mon 28 Dec 09:30.
    assert.equal(iso(addBusinessMinutes(at("2026-12-24T12:30:00Z"), 60, xmas)), "2026-12-28T09:30:00.000Z");
    assert.equal(inBusinessHours(at("2026-12-24T14:00:00Z"), xmas), false);
    // Thu 31 Dec 17:00 + 60 → 30 on Thursday, 1 Jan closed, weekend → Mon 4 Jan 2027 09:30.
    assert.equal(iso(addBusinessMinutes(at("2026-12-31T17:00:00Z"), 60, xmas)), "2027-01-04T09:30:00.000Z");
  });

  test("a partial closure in the middle of the day", () => {
    const h = cal("Europe/London", week(OFFICE), [hol("2026-11-11", "Remembrance", { closed_from: "10:45", closed_to: "11:15" })]);
    assert.equal(iso(addBusinessMinutes(at("2026-11-11T10:30:00Z"), 30, h)), "2026-11-11T11:30:00.000Z");
  });

  test("yearly holidays repeat every year (and 29 February only in leap years)", () => {
    const h = cal("Europe/London", week(OFFICE), [hol("2020-12-25", "Christmas Day", { recurring_yearly: true }), hol("2024-02-29", "Leap day", { recurring_yearly: true })]);
    assert.equal(inBusinessHours(at("2026-12-25T10:00:00Z"), h), false);
    assert.equal(inBusinessHours(at("2030-12-25T10:00:00Z"), h), false);
    assert.equal(inBusinessHours(at("2026-12-24T10:00:00Z"), h), true);
    assert.equal(inBusinessHours(at("2028-02-29T10:00:00Z"), h), false);
    assert.equal(inBusinessHours(at("2027-03-01T10:00:00Z"), h), true);
  });

  test("a holiday on a closed day changes nothing", () => {
    const h = cal("Europe/London", week(OFFICE), [hol("2026-12-26", "Boxing Day")]); // a Saturday
    assert.equal(iso(addBusinessMinutes(at("2026-12-25T17:00:00Z"), 60, h)), iso(addBusinessMinutes(at("2026-12-25T17:00:00Z"), 60, LONDON)));
  });
});

describe("no open hours", () => {
  test("a calendar closed every day never loops and says so", () => {
    const closed = cal("Europe/London", [[], [], [], [], [], [], []]);
    assert.equal(hasOpenHours(closed), false);
    assert.equal(addBusinessMinutes(at("2026-11-09T10:00:00Z"), 60, closed).getTime(), HD_NO_OPEN_HOURS_DUE);
    assert.equal(businessMinutesBetween(at("2026-11-09T10:00:00Z"), at("2026-12-09T10:00:00Z"), closed), 0);
    assert.equal(inBusinessHours(at("2026-11-09T10:00:00Z"), closed), false);
    assert.equal(nextOpening(at("2026-11-09T10:00:00Z"), closed), null);
    assert.equal(explainDue(at("2026-11-09T10:00:00Z"), 60, closed).no_open_hours, true);
  });

  test("holidays covering every open day for years hit the scan limit, quickly", () => {
    const holidays: H[] = [];
    for (let t = at("2026-11-02T12:00:00Z"); t < at("2030-01-01T00:00:00Z"); t += 7 * 86_400_000) holidays.push(hol(iso(t).slice(0, 10), "Closed Monday"));
    const mondays = cal("Europe/London", [[], OFFICE, [], [], [], [], []], holidays);
    const t0 = Date.now();
    assert.equal(addBusinessMinutes(at("2026-11-06T10:00:00Z"), 60, mondays).getTime(), HD_NO_OPEN_HOURS_DUE);
    assert.ok(Date.now() - t0 < 5000, "the guard is cheap");
  });
});

describe("words", () => {
  test("the preview explains a closure: opens Tue 09:00 (Easter Monday closed)", () => {
    const h = cal("Europe/London", week(OFFICE), [hol("2026-04-06", "Easter Monday")]);
    // Sat 4 Apr 2026 12:00 BST.
    const e = explainDue(at("2026-04-04T11:00:00Z"), 60, h);
    assert.equal(e.due, "2026-04-07T09:00:00.000Z"); // Tue 10:00 BST
    assert.match(e.summary, /opens Tue 09:00 \(Easter Monday closed\)/);
    assert.ok(e.lines.some((l) => /1h counted/.test(l)));
  });

  test("the clock note: paused for a holiday, outside hours, nothing while open", () => {
    const h = cal("Europe/London", week(OFFICE), [hol("2026-12-25", "Christmas Day")]);
    const t = { status: "open" as const, first_reply_due: "2026-12-30T12:00:00Z", resolve_due: "2027-01-05T12:00:00Z", first_replied_at: null, sla_paused_at: null };
    assert.equal(clockNoteWith(t, h, at("2026-12-25T12:00:00Z")), "Paused for Christmas Day, resumes Mon 09:00");
    assert.equal(clockNoteWith(t, h, at("2026-12-29T19:00:00Z")), "Outside office hours, resumes tomorrow 09:00");
    assert.equal(clockNoteWith(t, h, at("2026-12-29T10:00:00Z")), null);
    // Paused by status, or a calendar-time target: no note.
    assert.equal(clockNoteWith({ ...t, status: "pending", sla_paused_at: "2026-12-24T10:00:00Z" }, h, at("2026-12-25T12:00:00Z")), null);
    assert.equal(clockNoteWith(t, h, at("2026-12-25T12:00:00Z"), false), null);
    // Christmas Eve evening: the next opening is past a holiday.
    assert.equal(clockNoteWith(t, h, at("2026-12-24T19:00:00Z")), "Paused for Christmas Day, resumes Mon 09:00");
  });

  test("the requester's open state", () => {
    const h = cal("Europe/London", week(OFFICE), [hol("2026-12-25", "Christmas Day")]);
    const closed = openStateWith(h, "IT", at("2026-12-25T12:00:00Z"));
    assert.equal(closed.open, false);
    assert.equal(closed.holidayName, "Christmas Day");
    assert.equal(closed.opensAt, "2026-12-28T09:00:00.000Z");
    assert.equal(closed.message, "The IT team is closed for Christmas Day. We'll reply from Mon 09:00.");
    const open = openStateWith(h, "Facilities team", at("2026-12-29T10:00:00Z"));
    assert.equal(open.open, true);
    assert.equal(open.closesAt, "2026-12-29T17:30:00.000Z");
    assert.equal(open.message, "The Facilities team is open until today 17:30.");
    assert.match(openStateWith(h, null, at("2026-12-29T20:00:00Z")).message, /^The helpdesk is closed right now\. We'll reply from tomorrow 09:00\.$/);
  });

  test("schedule summaries", () => {
    assert.equal(summarizeSchedule(week(OFFICE)), "Mon–Fri 09:00–17:30");
    assert.equal(summarizeSchedule([[], OFFICE, OFFICE, OFFICE, OFFICE, [{ start: "09:00", end: "16:00" }], []]), "Mon–Thu 09:00–17:30 · Fri 09:00–16:00");
    assert.equal(summarizeSchedule(week([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }])), "Mon–Fri 08:00–12:00, 13:00–17:00");
    assert.equal(summarizeSchedule(ALWAYS("UTC").schedule!), "Open 24/7");
    assert.equal(summarizeSchedule([[], [], [], [], [], [], []]), "Closed every day");
  });

  test("schedule validation rejects overlaps and bad times", () => {
    assert.equal(validateSchedule(week(OFFICE)).ok, true);
    assert.equal(validateSchedule(week([{ start: "22:00", end: "06:00" }])).ok, true);
    const overlap = validateSchedule(week([{ start: "09:00", end: "13:00" }, { start: "12:00", end: "17:00" }]));
    assert.equal(overlap.ok, false);
    assert.equal(validateSchedule(week([{ start: "9:00", end: "17:00" }])).ok, false);
    assert.equal(validateSchedule(week([{ start: "09:00", end: "09:00" }])).ok, false);
    assert.equal(validateSchedule([[]]).ok, false);
  });
});

describe("parsers", () => {
  test("pasted lines", () => {
    const r = parseHolidayLines("2026-12-25 Christmas Day\n2026-12-24, 13:00-24:00 Christmas Eve afternoon\n# a comment\n\n2027-01-01\tNew Year's Day (yearly)\nnonsense\n2026-02-30 Not a date");
    assert.deepEqual(
      r.holidays.map((h) => [h.date, h.name, h.closed_from, h.closed_to, h.recurring_yearly]),
      [
        ["2026-12-25", "Christmas Day", null, null, false],
        ["2026-12-24", "Christmas Eve afternoon", "13:00", null, false],
        ["2027-01-01", "New Year's Day", null, null, true],
      ]
    );
    assert.deepEqual(r.errors.map((e) => e.line), [6, 7]);
  });

  test(".ics: all-day events, yearly rules, folded and escaped text, multi-day spans", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20261225",
      "DTEND;VALUE=DATE:20261226",
      "SUMMARY:Christmas Day",
      "RRULE:FREQ=YEARLY",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260831",
      "SUMMARY:Summer bank holiday\\, England",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20261228",
      "DTEND;VALUE=DATE:20261231",
      "SUMMARY:Office shut",
      " down",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;TZID=Europe/London:20261224T130000",
      "DTEND;TZID=Europe/London:20261224T173000",
      "SUMMARY:Christmas Eve",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260504",
      "RRULE:FREQ=YEARLY;BYDAY=1MO;BYMONTH=5",
      "SUMMARY:Early May bank holiday",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const r = parseIcs(ics);
    assert.deepEqual(
      r.holidays.map((h) => [h.date, h.name, h.recurring_yearly, h.closed_from, h.closed_to]),
      [
        ["2026-12-25", "Christmas Day", true, null, null],
        ["2026-08-31", "Summer bank holiday, England", false, null, null],
        ["2026-12-28", "Office shutdown", false, null, null],
        ["2026-12-29", "Office shutdown", false, null, null],
        ["2026-12-30", "Office shutdown", false, null, null],
        ["2026-12-24", "Christmas Eve", false, "13:00", "17:30"],
        ["2026-05-04", "Early May bank holiday", false, null, null],
      ]
    );
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /repeat rule not supported/);
  });
});

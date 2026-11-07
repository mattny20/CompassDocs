// Helpdesk 1.19.1 recurring tickets (agent V8): the pattern math (daily,
// weekly, nth weekday and last weekday, day of month in short months,
// quarterly months, every N weeks), holidays (next working day, skip, same
// day, two runs never on one date), clock changes, the due in business days
// and the placeholders; then the engine against the database: the sweep is
// idempotent per occurrence (two sweeps at once, a claim left by a crash),
// the after-create hooks run (the team's round robin assigns it), Open one
// now, the preview with the team's holidays, the API's team scope for leads
// and the audit rows.
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-assignment does).
//
// Parallel-safe: every team, account, calendar, holiday list and schedule
// here is this file's own (STAMP). The sweep only ever sees due schedules,
// and only this file's are made due. The shared dev server's minute tick
// may run the same sweep at the same time; the assertions read the
// database, which holds the same answer whoever swept.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-recurring.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-recurring.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-recurring.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const shared = require("../src/lib/helpdesk/recurring-shared") as typeof import("../src/lib/helpdesk/recurring-shared");
const recurring = require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
const calShared = require("../src/lib/helpdesk/calendars-shared") as typeof import("../src/lib/helpdesk/calendars-shared");
const aShared = require("../src/lib/helpdesk/assignment/shared") as typeof import("../src/lib/helpdesk/assignment/shared");
const aStore = require("../src/lib/helpdesk/assignment/store") as typeof import("../src/lib/helpdesk/assignment/store");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const push = require("../src/lib/helpdesk/push") as typeof import("../src/lib/helpdesk/push");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const listRoute = require("../src/app/api/helpdesk/admin/recurring/route") as typeof import("../src/app/api/helpdesk/admin/recurring/route");
const oneRoute = require("../src/app/api/helpdesk/admin/recurring/[id]/route") as typeof import("../src/app/api/helpdesk/admin/recurring/[id]/route");
const runRoute = require("../src/app/api/helpdesk/admin/recurring/[id]/run/route") as typeof import("../src/app/api/helpdesk/admin/recurring/[id]/run/route");
const previewRoute = require("../src/app/api/helpdesk/admin/recurring/preview/route") as typeof import("../src/app/api/helpdesk/admin/recurring/preview/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { RecurringPattern } from "../src/lib/helpdesk/recurring-shared";
import type { HdBusinessHours } from "../src/lib/helpdesk/types";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Pure: helpers ---------------------------------------------------------------------

const OFFICE = [[], ...Array.from({ length: 5 }, () => [{ start: "09:00", end: "17:00" }]), []];
const UK: HdBusinessHours = calShared.hoursFromCalendar({ id: 1, name: "UK", timezone: "Europe/London", schedule: OFFICE }, [
  { date: "2027-05-03", name: "Early May bank holiday", recurring_yearly: false, closed_from: null, closed_to: null },
  { date: "2026-12-25", name: "Christmas Day", recurring_yearly: true, closed_from: null, closed_to: null },
  { date: "2027-01-01", name: "New Year's Day", recurring_yearly: false, closed_from: null, closed_to: null },
  { date: "2027-02-01", name: "Half day", recurring_yearly: false, closed_from: "13:00", closed_to: "17:00" },
]);
const at = (s: string) => Date.parse(s);
const iso = (t: number) => new Date(t).toISOString();
const keys = (p: RecurringPattern, after: string, count: number, opts: { tz?: string; rule?: "next_working_day" | "skip" | "same_day"; hours?: HdBusinessHours | null } = {}) =>
  shared.nextOccurrences(p, { tz: opts.tz ?? "UTC", rule: opts.rule ?? "same_day", hours: opts.hours ?? null, after: at(after), count });

describe("pattern math (pure)", () => {
  test("monthly nth weekday: first Monday, last Friday, every month or only the listed months", () => {
    const first: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [], time: "09:00" };
    assert.deepEqual(keys(first, "2026-11-06T00:00:00Z", 3).map((o) => o.key), ["2026-12-07", "2027-01-04", "2027-02-01"]);
    const lastFri: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: -1, weekday: 5, months: [], time: "09:00" };
    assert.deepEqual(keys(lastFri, "2026-11-01T00:00:00Z", 3).map((o) => o.key), ["2026-11-27", "2026-12-25", "2027-01-29"]);
    const quarterly: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [1, 4, 7, 10], time: "09:00" };
    assert.deepEqual(keys(quarterly, "2026-11-06T00:00:00Z", 3).map((o) => o.key), ["2027-01-04", "2027-04-05", "2027-07-05"]);
    const fourthThu: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: 4, weekday: 4, months: [11], time: "09:00" };
    assert.deepEqual(keys(fourthThu, "2026-01-01T00:00:00Z", 2).map((o) => o.key), ["2026-11-26", "2027-11-25"]);
  });

  test("monthly by day: the 31st falls on a short month's last day; -1 is always the last day", () => {
    const d31: RecurringPattern = { kind: "monthly", mode: "day", day: 31, months: [], time: "08:00" };
    assert.deepEqual(keys(d31, "2027-01-01T00:00:00Z", 4).map((o) => o.key), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    const last: RecurringPattern = { kind: "monthly", mode: "day", day: -1, months: [2], time: "08:00" };
    assert.deepEqual(keys(last, "2027-03-01T00:00:00Z", 2).map((o) => o.key), ["2028-02-29", "2029-02-28"]);
  });

  test("daily, weekly and every N weeks from a start date; after an instant, not on it", () => {
    assert.deepEqual(keys({ kind: "daily", time: "09:00" }, "2026-11-06T09:00:00Z", 2).map((o) => o.key), ["2026-11-07", "2026-11-08"]);
    assert.deepEqual(keys({ kind: "daily", time: "09:00" }, "2026-11-06T08:59:00Z", 1).map((o) => o.key), ["2026-11-06"]);
    const wk: RecurringPattern = { kind: "weekly", days: [1, 3, 5], time: "09:00" };
    assert.deepEqual(keys(wk, "2026-11-06T10:00:00Z", 4).map((o) => o.key), ["2026-11-09", "2026-11-11", "2026-11-13", "2026-11-16"]);
    const fortnight: RecurringPattern = { kind: "interval", unit: "weeks", every: 2, start: "2026-11-02", time: "09:00" };
    assert.deepEqual(keys(fortnight, "2026-11-06T00:00:00Z", 3).map((o) => o.key), ["2026-11-16", "2026-11-30", "2026-12-14"]);
    const days10: RecurringPattern = { kind: "interval", unit: "days", every: 10, start: "2026-12-01", time: "09:00" };
    assert.deepEqual(keys(days10, "2026-11-06T00:00:00Z", 2).map((o) => o.key), ["2026-12-01", "2026-12-11"]);
  });

  test("holidays: next working day moves past the holiday and the weekend; skip drops it; same day keeps it", () => {
    const firstMon: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [5], time: "09:00" };
    const moved = keys(firstMon, "2027-04-01T00:00:00Z", 1, { tz: "Europe/London", rule: "next_working_day", hours: UK })[0];
    assert.equal(moved.key, "2027-05-03");
    assert.equal(shared.isoDate(moved.date), "2027-05-04");
    assert.equal(iso(moved.at), "2027-05-04T08:00:00.000Z"); // 09:00 BST
    assert.equal(shared.occurrenceNote(moved), "moved from Mon May 3, Early May bank holiday");
    const skipped = keys(firstMon, "2027-04-01T00:00:00Z", 1, { tz: "Europe/London", rule: "skip", hours: UK })[0];
    assert.equal(skipped.key, "2028-05-01");
    assert.match(shared.occurrenceNote(skipped), /Mon May 3 skipped for Early May bank holiday/);
    assert.equal(keys(firstMon, "2027-04-01T00:00:00Z", 1, { tz: "Europe/London", rule: "same_day", hours: UK })[0].key, "2027-05-03");
    // Christmas 2026 is a Friday: the next working day is Monday the 28th (the weekend has no office hours).
    const lastFri: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: -1, weekday: 5, months: [12], time: "10:00" };
    const xmas = keys(lastFri, "2026-12-01T00:00:00Z", 1, { tz: "Europe/London", rule: "next_working_day", hours: UK })[0];
    assert.equal(shared.isoDate(xmas.date), "2026-12-28");
    // A part-day closure is not a holiday.
    const feb = keys({ kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [2], time: "09:00" }, "2027-01-15T00:00:00Z", 1, { tz: "Europe/London", rule: "next_working_day", hours: UK })[0];
    assert.equal(shared.isoDate(feb.date), "2027-02-01");
    assert.equal(shared.occurrenceNote(feb), "");
  });

  test("a moved run never lands on the same date as the next one: one run stands for both", () => {
    const daily: RecurringPattern = { kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" };
    const occ = keys(daily, "2027-04-30T12:00:00Z", 3, { tz: "Europe/London", rule: "next_working_day", hours: UK });
    // Mon May 3 (holiday) moves to Tue May 4, which is also Tuesday's own run.
    assert.deepEqual(occ.map((o) => shared.isoDate(o.date)), ["2027-05-04", "2027-05-05", "2027-05-06"]);
    assert.equal(occ[0].key, "2027-05-03");
  });

  test("a run scheduled before `after` but moved past it by a holiday is still the next one", () => {
    const firstMon: RecurringPattern = { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [5], time: "09:00" };
    const o = keys(firstMon, "2027-05-03T12:00:00Z", 1, { tz: "Europe/London", rule: "next_working_day", hours: UK })[0];
    assert.equal(o.key, "2027-05-03");
    assert.equal(shared.isoDate(o.date), "2027-05-04");
  });

  test("clock changes: 09:00 stays 09:00 local; a time inside the spring gap moves on with the clock", () => {
    const mon: RecurringPattern = { kind: "weekly", days: [1], time: "09:00" };
    const london = keys(mon, "2026-10-15T00:00:00Z", 2, { tz: "Europe/London" });
    assert.deepEqual(london.map((o) => iso(o.at)), ["2026-10-19T08:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
    const ny = keys({ kind: "daily", time: "02:30" }, "2027-03-13T12:00:00Z", 2, { tz: "America/New_York" });
    assert.equal(iso(ny[0].at), "2027-03-14T07:30:00.000Z"); // 02:30 doesn't exist: the clock jumped, so 03:30 EDT
    assert.equal(iso(ny[1].at), "2027-03-15T06:30:00.000Z"); // 02:30 EDT
    const fall = keys({ kind: "daily", time: "01:30" }, "2026-11-01T00:00:00Z", 1, { tz: "America/New_York" });
    assert.equal(iso(fall[0].at), "2026-11-01T05:30:00.000Z"); // the earlier 01:30 (EDT)
  });

  test("the sweep finds a stored key's run in any zone: evenings west of Greenwich, mornings east of it", () => {
    const find = (p: RecurringPattern, key: string, tz: string, rule: "next_working_day" | "skip" | "same_day" = "same_day", hours: HdBusinessHours | null = null) =>
      shared.occurrenceForKey(p, key, { tz, rule, hours });
    // 1.19.1 review: these came back "gone", so evening schedules in the Americas never opened a ticket.
    assert.equal(iso(find({ kind: "daily", time: "17:00" }, "2026-12-10", "America/Los_Angeles")!.at), "2026-12-11T01:00:00.000Z");
    assert.equal(iso(find({ kind: "daily", time: "23:59" }, "2026-12-10", "America/Los_Angeles")!.at), "2026-12-11T07:59:00.000Z");
    assert.equal(iso(find({ kind: "daily", time: "20:00" }, "2026-12-10", "America/New_York")!.at), "2026-12-11T01:00:00.000Z");
    const weekdays: RecurringPattern = { kind: "weekly", days: [1, 2, 3, 4, 5], time: "18:30" };
    assert.equal(iso(find(weekdays, "2026-12-10", "America/Los_Angeles")!.at), "2026-12-11T02:30:00.000Z"); // Thursday
    assert.equal(iso(find(weekdays, "2026-12-11", "America/Los_Angeles")!.at), "2026-12-12T02:30:00.000Z"); // Friday
    assert.equal(find(weekdays, "2026-12-12", "America/Los_Angeles"), null, "Saturday is not a date of the pattern");
    // East of Greenwich the local date runs ahead of UTC.
    assert.equal(iso(find({ kind: "daily", time: "00:15" }, "2026-12-10", "Pacific/Auckland")!.at), "2026-12-09T11:15:00.000Z");
    assert.equal(iso(find({ kind: "daily", time: "23:45" }, "2026-12-10", "Pacific/Auckland")!.at), "2026-12-10T10:45:00.000Z");
    assert.equal(iso(find({ kind: "daily", time: "08:00" }, "2026-12-10", "Asia/Tokyo")!.at), "2026-12-09T23:00:00.000Z");
    // Clock changes: New York springs forward Mar 8 and falls back Nov 1 2026.
    assert.equal(iso(find({ kind: "daily", time: "20:00" }, "2026-03-07", "America/New_York")!.at), "2026-03-08T01:00:00.000Z");
    assert.equal(iso(find({ kind: "daily", time: "20:00" }, "2026-03-08", "America/New_York")!.at), "2026-03-09T00:00:00.000Z");
    assert.equal(iso(find({ kind: "daily", time: "20:00" }, "2026-11-01", "America/New_York")!.at), "2026-11-02T01:00:00.000Z");
    // A holiday on the key's date in a Los Angeles calendar: moved to the next working day, or skipped.
    const LA: HdBusinessHours = calShared.hoursFromCalendar({ id: 2, name: "LA", timezone: "America/Los_Angeles", schedule: OFFICE }, [
      { date: "2026-12-10", name: "Office closed", recurring_yearly: false, closed_from: null, closed_to: null },
    ]);
    const moved = find({ kind: "daily", time: "17:00" }, "2026-12-10", "America/Los_Angeles", "next_working_day", LA)!;
    assert.equal(shared.isoDate(moved.date), "2026-12-11");
    assert.equal(iso(moved.at), "2026-12-12T01:00:00.000Z");
    assert.equal(find(weekdays, "2026-12-10", "America/Los_Angeles", "skip", LA), null);
    // Every run of a long enumeration is found again from its key, across both clock changes, in zones on both sides.
    const zones = ["America/Los_Angeles", "America/New_York", "Pacific/Pago_Pago", "UTC", "Europe/London", "Asia/Tokyo", "Pacific/Auckland", "Pacific/Kiritimati"];
    const times = ["00:00", "00:30", "01:30", "02:30", "09:00", "17:00", "20:00", "23:30", "23:59"];
    for (const tz of zones) {
      for (const time of times) {
        for (const p of [{ kind: "daily", time }, { kind: "weekly", days: [1, 2, 3, 4, 5], time }, { kind: "weekly", days: [4, 5], time }] as RecurringPattern[]) {
          for (const from of ["2026-02-20T00:00:00Z", "2026-09-20T00:00:00Z"]) {
            for (const o of shared.nextOccurrences(p, { tz, rule: "same_day", hours: null, after: at(from), count: 60, lookbackDays: 0 })) {
              const again = find(p, o.key, tz);
              assert.ok(again, `${tz} ${JSON.stringify(p)} ${o.key}: found`);
              assert.equal(again.at, o.at, `${tz} ${JSON.stringify(p)} ${o.key}: same instant`);
            }
          }
        }
      }
    }
  });

  test("due in business days: the close of the nth working day, past weekends and holidays", () => {
    // Thu Dec 24 2026 10:00 London + 2 business days: Fri 25 is Christmas, weekend → Mon 28, Tue 29 → 17:00 GMT.
    assert.equal(iso(shared.dueAfterBusinessDays(at("2026-12-24T10:00:00Z"), 2, UK)), "2026-12-29T17:00:00.000Z");
    assert.equal(iso(shared.dueAfterBusinessDays(at("2026-12-24T10:00:00Z"), 3, null)), "2026-12-27T10:00:00.000Z");
  });

  test("validation: kinds, times, days, months and intervals", () => {
    assert.equal(shared.validatePattern({ kind: "daily", time: "9am" }).ok, false);
    assert.equal(shared.validatePattern({ kind: "weekly", days: [], time: "09:00" }).ok, false);
    assert.equal(shared.validatePattern({ kind: "weekly", days: [8], time: "09:00" }).ok, false);
    assert.equal(shared.validatePattern({ kind: "monthly", mode: "nth_weekday", nth: 5, weekday: 1, time: "09:00" }).ok, false);
    assert.equal(shared.validatePattern({ kind: "interval", unit: "weeks", every: 53, start: "2026-01-01", time: "09:00" }).ok, false);
    assert.equal(shared.validatePattern({ kind: "interval", unit: "days", every: 3, start: "2026-02-30", time: "09:00" }).ok, false);
    const all = shared.validatePattern({ kind: "monthly", mode: "day", day: 1, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], time: "09:00" });
    assert.ok(all.ok && all.value.kind === "monthly" && all.value.months.length === 0, "every month picked is every month");
    assert.ok(shared.validTimezone("Europe/London"));
    assert.equal(shared.validTimezone("Mars/Base"), false);
  });

  test("words: the list summary, the title and the placeholders", () => {
    assert.equal(shared.patternSummary({ kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [], time: "09:00" }), "first Monday");
    assert.equal(shared.patternSummary({ kind: "weekly", days: [5], time: "09:00" }), "every Friday 09:00");
    assert.equal(shared.patternSummary({ kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [1, 4, 7, 10], time: "09:00" }), "first Monday · Jan, Apr, Jul, Oct");
    assert.equal(shared.patternSummary({ kind: "interval", unit: "weeks", every: 2, start: "2026-11-02", time: "09:00" }), "every 2 weeks");
    assert.equal(shared.scheduleTitle("Monthly backup restore test: {{month}}"), "Monthly backup restore test");
    assert.equal(
      shared.renderTemplate("Restore test: {{month}} · {{date}} · {{week}} · {{team}}", { date: { y: 2026, m: 12, d: 7 }, team: "IT" }),
      "Restore test: December 2026 · Mon 7 Dec 2026 · Week 50, 2026 · IT"
    );
  });
});

// --- Database fixtures ---------------------------------------------------------------------

const STAMP = `hdrec-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; session: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
let calId = 0;
let setId = 0;

async function person(key: string, deskRole: string | null) {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    `${key} ${STAMP}`,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session };
}

const NEXT_YEAR = new Date().getUTCFullYear() + 1;

before(async () => {
  await getSetting("__schema_bootstrap__");
  await aStore.assignmentReady();
  const cal = await pool().query("INSERT INTO hd_calendars (name, timezone, schedule) VALUES ($1, 'Europe/London', $2) RETURNING id", [`${STAMP} office`, JSON.stringify(OFFICE)]);
  calId = cal.rows[0].id;
  const set = await pool().query("INSERT INTO hd_holiday_sets (name) VALUES ($1) RETURNING id", [`${STAMP} holidays`]);
  setId = set.rows[0].id;
  // May Day next year: the first Monday of May.
  const may1 = new Date(Date.UTC(NEXT_YEAR, 4, 1));
  const firstMon = 1 + ((8 - (may1.getUTCDay() || 7)) % 7);
  await pool().query("INSERT INTO hd_holidays (set_id, date, name) VALUES ($1, $2, 'May Day')", [setId, `${NEXT_YEAR}-05-${String(firstMon).padStart(2, "0")}`]);
  await pool().query("INSERT INTO hd_calendar_holiday_sets (calendar_id, set_id) VALUES ($1, $2)", [calId, setId]);
  for (const k of ["A", "B"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position, calendar_id) VALUES ($1, 9300, $2) RETURNING id", [`${STAMP} ${k}`, calId]);
    T[k] = r.rows[0].id;
  }
  await person("admin", "admin");
  await person("lead", "team_lead");
  await person("agent", "agent");
  await person("other", "agent");
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'lead'), ($1, $3, 'agent'), ($4, $5, 'agent')", [T.A, P.lead.id, P.agent.id, T.B, P.other.id]);
  calendars.invalidateCalendarCache();
  email.setHelpdeskTransportForTests(async () => {});
  push.setPushTransportForTests(async () => ({ status: 201, headers: {} }) as never);
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  push.setPushTransportForTests(null);
  await pool().query("DELETE FROM hd_recurring WHERE team_id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1) OR subject LIKE $2", [Object.values(T), `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM hd_calendars WHERE id = $1", [calId]);
  await pool().query("DELETE FROM hd_holiday_sets WHERE id = $1", [setId]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (action LIKE 'helpdesk.recurring.%' AND target_label LIKE $2)", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  calendars.invalidateCalendarCache();
  await pool().end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sweep until the schedule's next run is in the future (another instance may hold the sweep's lock for a moment). */
async function sweepUntilAdvanced(id: number) {
  for (let i = 0; i < 40; i++) {
    await Promise.all([recurring.recurringSweep(), recurring.recurringSweep()]);
    const r = await pool().query("SELECT next_run_at FROM hd_recurring WHERE id = $1", [id]);
    if (r.rows[0].next_run_at && new Date(r.rows[0].next_run_at).getTime() > Date.now()) return;
    await sleep(250);
  }
  assert.fail("the sweep never moved the schedule on");
}

const ticketsOf = async (id: number) =>
  (
    await pool().query<{ id: number; number: number; subject: string; source: string; assignee_id: number | null; resolve_due: Date | null; source_ref: { occurrence: string }; requester_id: number | null }>(
      "SELECT id, number, subject, source, assignee_id, resolve_due, source_ref, requester_id FROM hd_tickets WHERE source = 'recurring' AND (source_ref ->> 'recurring_id')::int = $1 ORDER BY id",
      [id]
    )
  ).rows;

const base = (team: number, extra: Record<string, unknown> = {}) => ({
  team_id: team,
  subject: `Fire alarm test {{date}} ${STAMP}`,
  body: "Test every call point on {{date}}.",
  priority: "high",
  pattern: { kind: "weekly", days: [5], time: "09:00" },
  holiday_rule: "next_working_day",
  timezone: "",
  ...extra,
});

describe("recurring schedules (database)", () => {
  test("the sweep is listed in HELPDESK_SWEEPS", () => {
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_recurring"));
  });

  test("every helpdesk sweep's advisory lock key is its own (recurring no longer shares retention's)", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const keysInUse = {
      sla: (require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla")).SLA_SWEEP_LOCK,
      calendars: (require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars")).CALENDAR_RECOMPUTE_LOCK,
      assignment: (require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine")).ASSIGNMENT_SWEEP_LOCK,
      retention: (require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention")).RETENTION_LOCK,
      recurring: recurring.RECURRING_SWEEP_LOCK,
      assets: (require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets")).ASSETS_SYNC_LOCK,
      intune: (require("../src/lib/helpdesk/assets") as typeof import("../src/lib/helpdesk/assets")).INTUNE_SYNC_LOCK,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
    const values = Object.values(keysInUse);
    assert.equal(new Set(values).size, values.length, JSON.stringify(keysInUse));
  });

  test("API scope: a lead schedules for their team only; an agent can't; the admin sees every team", async () => {
    const own = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A)));
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.schedule.timezone, "Europe/London", "an empty zone is the team calendar's");
    assert.ok(own.body.schedule.next_run_at, "a next run is worked out on save");
    const foreign = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.B)));
    assert.equal(foreign.status, 403);
    assert.equal((await call(listRoute.GET, req("/admin/recurring", P.agent.session))).status, 403);
    const adminB = await call(listRoute.POST, req("/admin/recurring", P.admin.session, base(T.B, { subject: `Kit restock ${STAMP}` })));
    assert.equal(adminB.status, 201);
    const leadList = await call(listRoute.GET, req("/admin/recurring", P.lead.session));
    assert.deepEqual(leadList.body.teams.map((t: { id: number }) => t.id), [T.A]);
    assert.ok(leadList.body.schedules.every((s: { team_id: number }) => s.team_id === T.A));
    assert.equal(leadList.body.can_manage_all, false);
    // Another team's schedule answers 404 to the lead, and can't be moved onto their team or away from it.
    assert.equal((await call(oneRoute.GET, req(`/admin/recurring/${adminB.body.schedule.id}`, P.lead.session), { id: String(adminB.body.schedule.id) })).status, 404);
    const move = await call(oneRoute.PATCH, req(`/admin/recurring/${own.body.schedule.id}`, P.lead.session, { team_id: T.B }, "PATCH"), { id: String(own.body.schedule.id) });
    assert.equal(move.status, 403);
    const adminList = await call(listRoute.GET, req("/admin/recurring", P.admin.session));
    const mine = adminList.body.schedules.filter((s: { team_id: number }) => s.team_id === T.A || s.team_id === T.B);
    assert.equal(mine.length, 2);
    assert.equal(adminList.body.can_manage_all, true);
  });

  test("validation: subject, a named assignee from the team, due days, pattern", async () => {
    const bad = async (extra: Record<string, unknown>) => (await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A, extra)))).status;
    assert.equal(await bad({ subject: "  " }), 400);
    assert.equal(await bad({ assign_mode: "user", assignee_id: P.other.id }), 400, "not in the team");
    assert.equal(await bad({ due_business_days: 0 }), 400);
    assert.equal(await bad({ pattern: { kind: "weekly", days: [], time: "09:00" } }), 400);
    assert.equal(await bad({ timezone: "Nowhere/Land" }), 400);
    assert.equal(await bad({ assign_mode: "user", assignee_id: P.agent.id }), 201);
  });

  test("preview: the next three runs with the team calendar's holiday moved", async () => {
    const r = await call(
      previewRoute.POST,
      req("/admin/recurring/preview", P.lead.session, { team_id: T.A, pattern: { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [5], time: "09:00" }, holiday_rule: "next_working_day" })
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 3);
    assert.match(r.body.items[0].label, /^Tue May \d+$/);
    assert.match(r.body.items[0].note, /^moved from Mon May \d+, May Day$/);
    const other = await call(previewRoute.POST, req("/admin/recurring/preview", P.lead.session, { team_id: T.B, pattern: { kind: "daily", time: "09:00" } }));
    assert.equal(other.status, 400, "not the lead's team");
  });

  test("the sweep opens one ticket per occurrence, whatever runs at once, and the hooks assign it", async () => {
    // Team A takes tickets in turn; the agent is its only available taker.
    const cur = await aStore.getTeamAssignment(T.A);
    const v = aShared.validateTeamAssignment({ mode: "round_robin", include_roles: ["agent"], eligible: "available_or_away", respect_shift: 0 }, cur);
    assert.ok(v.ok, v.ok ? "" : v.error);
    await aStore.saveTeamAssignment(v.value, null);
    await pool().query("UPDATE hd_team_members SET role = 'lead' WHERE team_id = $1 AND user_id = $2", [T.A, P.lead.id]);

    const created = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A, { subject: `Backup restore test: {{month}} ${STAMP}`, due_business_days: 3 })));
    const id = created.body.schedule.id as number;
    await pool().query("UPDATE hd_recurring SET next_run_at = now() - interval '1 minute', next_key = '2026-01-02' WHERE id = $1", [id]);
    await sweepUntilAdvanced(id);
    const list = await ticketsOf(id);
    assert.equal(list.length, 1, "exactly one ticket for the occurrence");
    const t = list[0];
    assert.equal(t.source, "recurring");
    assert.equal(t.source_ref.occurrence, "2026-01-02");
    assert.equal(t.requester_id, null, "nobody is the requester");
    assert.match(t.subject, /^Backup restore test: January 2026 /, "placeholders use the occurrence's date");
    assert.ok(t.resolve_due && new Date(t.resolve_due).getTime() > Date.now() + 24 * 3_600_000, "due in three business days");
    // The after-create hooks ran: the team's round robin assigned it (wait for whichever process swept).
    let assignee: number | null = null;
    for (let i = 0; i < 40 && !assignee; i++) {
      assignee = (await pool().query("SELECT assignee_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].assignee_id;
      if (!assignee) await sleep(250);
    }
    assert.equal(assignee, P.agent.id);
    const runs = await pool().query("SELECT ticket_id FROM hd_recurring_runs WHERE recurring_id = $1", [id]);
    assert.deepEqual(runs.rows.map((r) => r.ticket_id), [t.id]);
    const s = await recurring.getRecurring(id);
    assert.ok(s!.last_run_at);
    assert.equal(s!.last_ticket_number, t.number);

    // A claim a crashed run left behind: the sweep opens nothing more for that occurrence and moves on.
    await pool().query("INSERT INTO hd_recurring_runs (recurring_id, occurrence_key) VALUES ($1, '2026-01-09')", [id]);
    await pool().query("UPDATE hd_recurring SET next_run_at = now() - interval '1 minute', next_key = '2026-01-09' WHERE id = $1", [id]);
    await sweepUntilAdvanced(id);
    assert.equal((await ticketsOf(id)).length, 1);

    // Paused: nothing opens however late it is.
    await pool().query("UPDATE hd_recurring SET enabled = 0, next_run_at = now() - interval '1 minute', next_key = '2026-01-16' WHERE id = $1", [id]);
    await recurring.recurringSweep();
    assert.equal((await ticketsOf(id)).length, 1);
    await pool().query("UPDATE hd_recurring SET enabled = 1 WHERE id = $1", [id]);

    // The run is in the audit log.
    const audited = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.recurring.run' AND target_id = $1", [String(id)]);
    assert.ok(audited.rows.some((r) => r.details.occurrence === "2026-01-02"));
  });

  test("a holiday added after the run was worked out: the sweep opens nothing on it and waits for the moved date", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    const created = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A, { subject: `Daily check ${STAMP}`, pattern: { kind: "daily", time: "00:01" } })));
    const id = created.body.schedule.id as number;
    await pool().query("INSERT INTO hd_holidays (set_id, date, name) VALUES ($1, $2, 'Snow day')", [setId, today]);
    calendars.invalidateCalendarCache();
    try {
      await pool().query("UPDATE hd_recurring SET next_run_at = now() - interval '1 minute', next_key = $2 WHERE id = $1", [id, today]);
      await sweepUntilAdvanced(id);
      assert.equal((await ticketsOf(id)).length, 0, "nothing opens on the holiday");
      const s = (await pool().query("SELECT next_key, next_run_at FROM hd_recurring WHERE id = $1", [id])).rows[0];
      assert.equal(s.next_key, today, "the same occurrence, moved to the next working day");
      const moved = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(s.next_run_at));
      assert.ok(moved > today);
      // A key that is no longer a date of the pattern opens nothing either.
      await pool().query("UPDATE hd_recurring SET pattern = '{\"kind\":\"weekly\",\"days\":[7],\"time\":\"00:01\"}', next_run_at = now() - interval '1 minute', next_key = '2026-01-05' WHERE id = $1", [id]);
      await sweepUntilAdvanced(id);
      assert.equal((await ticketsOf(id)).length, 0);
    } finally {
      await pool().query("DELETE FROM hd_holidays WHERE set_id = $1 AND name = 'Snow day'", [setId]);
      calendars.invalidateCalendarCache();
    }
  });

  test("Open one now: a ticket straight away, the schedule's next run unchanged; a repeated click is one ticket", async () => {
    const created = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A, { subject: `Access review {{week}} ${STAMP}`, assign_mode: "user", assignee_id: P.agent.id })));
    const id = created.body.schedule.id as number;
    const before = (await recurring.getRecurring(id))!.next_run_at;
    const r = await call(runRoute.POST, req(`/admin/recurring/${id}/run`, P.lead.session, { request_id: `${STAMP}-click` }), { id: String(id) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await call(runRoute.POST, req(`/admin/recurring/${id}/run`, P.lead.session, { request_id: `${STAMP}-click` }), { id: String(id) });
    assert.equal(again.status, 409);
    const list = await ticketsOf(id);
    assert.equal(list.length, 1);
    assert.equal(list[0].number, r.body.ticket.number);
    assert.equal(list[0].assignee_id, P.agent.id, "the named assignee");
    assert.match(list[0].subject, /^Access review Week \d+, \d{4} /);
    assert.equal((await recurring.getRecurring(id))!.next_run_at, before);
    assert.equal((await call(runRoute.POST, req(`/admin/recurring/${id}/run`, P.other.session, {}), { id: String(id) })).status, 403, "an agent without the capability");
    const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.recurring.run' AND target_id = $1 AND actor_id = $2", [String(id), P.lead.id]);
    assert.equal(audited.rowCount, 1);
  });

  test("edit and delete are audited; editing recomputes the next run", async () => {
    const created = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A, { subject: `Edit me ${STAMP}` })));
    const id = String(created.body.schedule.id);
    const r = await call(oneRoute.PATCH, req(`/admin/recurring/${id}`, P.lead.session, { pattern: { kind: "monthly", mode: "day", day: 1, months: [], time: "07:30" } }, "PATCH"), { id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const next = new Date(r.body.schedule.next_run_at);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(next), "1, 07:30");
    const paused = await call(oneRoute.PATCH, req(`/admin/recurring/${id}`, P.lead.session, { enabled: false }, "PATCH"), { id });
    assert.equal(paused.body.schedule.next_run_at, null);
    assert.equal((await call(oneRoute.DELETE, req(`/admin/recurring/${id}`, P.lead.session, undefined, "DELETE"), { id })).status, 200);
    const actions = (await pool().query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_recurring' AND target_id = $1 ORDER BY id", [id])).rows.map((x) => x.action);
    assert.deepEqual(actions, ["helpdesk.recurring.created", "helpdesk.recurring.updated", "helpdesk.recurring.updated", "helpdesk.recurring.deleted"]);
  });

  test("evening runs west of Greenwich open their ticket (Los Angeles daily 17:00, New York weekdays 20:00 on a Friday)", async () => {
    const la = await call(listRoute.POST, req("/admin/recurring", P.lead.session, base(T.A, { subject: `LA close-out ${STAMP}`, pattern: { kind: "daily", time: "17:00" }, timezone: "America/Los_Angeles" })));
    const ny = await call(
      listRoute.POST,
      req("/admin/recurring", P.lead.session, base(T.A, { subject: `NY end of day ${STAMP}`, pattern: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "20:00" }, timezone: "America/New_York" }))
    );
    assert.equal(la.status, 201, JSON.stringify(la.body));
    assert.equal(ny.status, 201, JSON.stringify(ny.body));
    // Wed Jan 7 and Fri Jan 9 2026: both working days in team A's calendar.
    await pool().query("UPDATE hd_recurring SET next_run_at = now() - interval '1 minute', next_key = '2026-01-07' WHERE id = $1", [la.body.schedule.id]);
    await pool().query("UPDATE hd_recurring SET next_run_at = now() - interval '1 minute', next_key = '2026-01-09' WHERE id = $1", [ny.body.schedule.id]);
    await sweepUntilAdvanced(la.body.schedule.id);
    await sweepUntilAdvanced(ny.body.schedule.id);
    assert.deepEqual((await ticketsOf(la.body.schedule.id)).map((t) => t.source_ref.occurrence), ["2026-01-07"]);
    assert.deepEqual((await ticketsOf(ny.body.schedule.id)).map((t) => t.source_ref.occurrence), ["2026-01-09"]);
    assert.ok((await recurring.getRecurring(la.body.schedule.id))!.last_run_at, "the run is recorded");
  });
});

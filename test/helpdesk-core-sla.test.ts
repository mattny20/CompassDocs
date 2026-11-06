// Helpdesk 1.19.0 (core): the SLA arithmetic in lib/helpdesk/sla. Pure: no
// database, the business hours passed explicitly. Business minutes across
// evenings, weekends, holidays, other time zones and a DST change; dues
// under business and calendar policies; pause and resume keeping the time
// that was left; the derived sla_state and the queue's due_label.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-core-sla.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  computeDues,
  dueLabel,
  HD_NO_OPEN_HOURS_DUE,
  formatDuration,
  inBusinessHours,
  resumedDues,
  slaState,
  starterPolicies,
  zonedInstant,
} from "../src/lib/helpdesk/sla";
import type { HdBusinessHours, HdSlaPolicy, HdTicketRow } from "../src/lib/helpdesk/types";

const LONDON: HdBusinessHours = { timezone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", holidays: [] };
const NEW_YORK: HdBusinessHours = { ...LONDON, timezone: "America/New_York", start: "09:00", end: "17:00" };
const iso = (s: string) => new Date(s).toISOString();
const at = (s: string) => Date.parse(s);

describe("business-hours arithmetic", () => {
  test("zonedInstant reads the zone's wall clock, either side of a DST change", () => {
    assert.equal(new Date(zonedInstant(2026, 11, 9, 9, 0, "Europe/London")).toISOString(), "2026-11-09T09:00:00.000Z");
    assert.equal(new Date(zonedInstant(2026, 7, 6, 9, 0, "Europe/London")).toISOString(), "2026-07-06T08:00:00.000Z");
    assert.equal(new Date(zonedInstant(2026, 11, 9, 9, 0, "America/New_York")).toISOString(), "2026-11-09T14:00:00.000Z");
  });

  test("minutes inside one day stay inside it", () => {
    // Monday 10:00 London + 90 business minutes = 11:30.
    assert.equal(addBusinessMinutes(at("2026-11-09T10:00:00Z"), 90, LONDON).toISOString(), iso("2026-11-09T11:30:00Z"));
  });

  test("Friday afternoon + 4 business hours lands on Monday, skipping the weekend", () => {
    // Fri 16:30: 60 minutes left on Friday, 180 more from Monday 09:00 → Mon 12:00.
    assert.equal(addBusinessMinutes(at("2026-11-06T16:30:00Z"), 240, LONDON).toISOString(), iso("2026-11-09T12:00:00Z"));
    assert.equal(businessMinutesBetween(at("2026-11-06T16:30:00Z"), at("2026-11-09T12:00:00Z"), LONDON), 240);
  });

  test("a holiday is not a working day", () => {
    const hours = { ...LONDON, holidays: ["2026-11-09"] };
    assert.equal(addBusinessMinutes(at("2026-11-06T16:30:00Z"), 240, hours).toISOString(), iso("2026-11-10T12:00:00Z"));
    assert.equal(businessMinutesBetween(at("2026-11-06T16:30:00Z"), at("2026-11-10T12:00:00Z"), hours), 240);
  });

  test("a start outside hours counts from the next opening", () => {
    // Saturday → Monday 09:00 + 30.
    assert.equal(addBusinessMinutes(at("2026-11-07T12:00:00Z"), 30, LONDON).toISOString(), iso("2026-11-09T09:30:00Z"));
    // Before opening on a weekday.
    assert.equal(addBusinessMinutes(at("2026-11-10T06:00:00Z"), 60, LONDON).toISOString(), iso("2026-11-10T10:00:00Z"));
    // After closing → the next morning.
    assert.equal(addBusinessMinutes(at("2026-11-10T18:00:00Z"), 60, LONDON).toISOString(), iso("2026-11-11T10:00:00Z"));
    assert.equal(businessMinutesBetween(at("2026-11-07T00:00:00Z"), at("2026-11-08T23:59:00Z"), LONDON), 0);
  });

  test("two business days (2 × 8.5 hours) from Thursday afternoon", () => {
    const twoDays = 2 * 510;
    // Thu 15:00 → Thu 2.5h, Fri 8.5h, Mon 6h → Mon 15:00.
    assert.equal(addBusinessMinutes(at("2026-11-05T15:00:00Z"), twoDays, LONDON).toISOString(), iso("2026-11-09T15:00:00Z"));
  });

  test("another time zone: New York's day is 14:00–22:00 UTC in November", () => {
    // Fri 16:00 EST (21:00Z) + 120 → 60 on Friday, 60 from Monday 09:00 EST → 15:00Z.
    assert.equal(addBusinessMinutes(at("2026-11-06T21:00:00Z"), 120, NEW_YORK).toISOString(), iso("2026-11-09T15:00:00Z"));
    assert.equal(inBusinessHours(at("2026-11-06T21:00:00Z"), NEW_YORK), true);
    assert.equal(inBusinessHours(at("2026-11-06T21:00:00Z"), LONDON), false);
  });

  test("across the spring DST change the opening hour follows the wall clock", () => {
    // Fri 27 Mar 2026 17:00 GMT, 30 minutes left; BST from Sunday: Mon 09:00 BST = 08:00Z, +30 → 08:30Z.
    assert.equal(addBusinessMinutes(at("2026-03-27T17:00:00Z"), 60, LONDON).toISOString(), iso("2026-03-30T08:30:00Z"));
  });

  test("no working days at all falls back to calendar time instead of looping", () => {
    const none = { ...LONDON, days: [] };
    assert.equal(addBusinessMinutes(at("2026-11-06T16:30:00Z"), 60, none).toISOString(), iso("2026-11-06T17:30:00Z"));
  });
});

describe("dues, pause and resume", () => {
  const business: HdSlaPolicy = { id: 1, name: "Normal", priority: "normal", first_reply_minutes: 240, resolve_minutes: 1020, business_hours: 1 };
  const calendar: HdSlaPolicy = { ...business, business_hours: 0 };

  test("the starter set: urgent replies in an hour, everything else in 4 business hours and resolves in 2 business days", () => {
    const p = starterPolicies(LONDON);
    const by = Object.fromEntries(p.map((x) => [x.priority, x]));
    assert.equal(by.urgent.first_reply_minutes, 60);
    for (const k of ["high", "normal", "low"]) {
      assert.equal(by[k].first_reply_minutes, 240);
      assert.equal(by[k].resolve_minutes, 2 * 510);
    }
  });

  test("computeDues: business policy skips the weekend; calendar policy does not", () => {
    const d = computeDues(at("2026-11-06T16:30:00Z"), business, LONDON);
    assert.equal(d.first_reply_due.toISOString(), iso("2026-11-09T12:00:00Z"));
    const c = computeDues(at("2026-11-06T16:30:00Z"), calendar, LONDON);
    assert.equal(c.first_reply_due.toISOString(), iso("2026-11-06T20:30:00Z"));
  });

  test("resume keeps the business time that was left when it paused", () => {
    // Paused Fri 16:30 with the reply due Mon 12:00 (240 left); resumed Mon 10:00 → due Mon 14:00.
    const r = resumedDues(
      { first_reply_due: iso("2026-11-09T12:00:00Z"), resolve_due: iso("2026-11-10T12:00:00Z"), first_replied_at: null },
      at("2026-11-06T16:30:00Z"),
      at("2026-11-09T10:00:00Z"),
      business,
      LONDON
    );
    assert.equal(r.first_reply_due!.toISOString(), iso("2026-11-09T14:00:00Z"));
    // Resolution: 750 left (60 Fri + 510 Mon + 180 Tue) → from Mon 10:00: 450 Mon + 300 Tue → Tue 14:00.
    assert.equal(r.resolve_due!.toISOString(), iso("2026-11-10T14:00:00Z"));
  });

  test("a clock already past due when paused stays breached; a met first reply does not move", () => {
    const r = resumedDues(
      { first_reply_due: iso("2026-11-06T12:00:00Z"), resolve_due: iso("2026-11-06T16:00:00Z"), first_replied_at: iso("2026-11-06T11:00:00Z") },
      at("2026-11-06T16:30:00Z"),
      at("2026-11-09T10:00:00Z"),
      business,
      LONDON
    );
    assert.equal(r.first_reply_due!.toISOString(), iso("2026-11-06T12:00:00Z"));
    assert.equal(r.resolve_due!.toISOString(), iso("2026-11-06T16:00:00Z"));
  });
});

describe("derived state and labels", () => {
  const base: Pick<HdTicketRow, "status" | "first_reply_due" | "resolve_due" | "first_replied_at" | "solved_at" | "sla_paused_at" | "created_at"> = {
    status: "open",
    created_at: iso("2026-11-09T09:00:00Z"),
    first_reply_due: iso("2026-11-09T13:00:00Z"),
    resolve_due: iso("2026-11-11T09:00:00Z"),
    first_replied_at: null,
    solved_at: null,
    sla_paused_at: null,
  };

  test("ok, warn, breached, paused, met", () => {
    assert.equal(slaState(base, at("2026-11-09T10:00:00Z")), "ok");
    assert.equal(slaState(base, at("2026-11-09T12:30:00Z")), "warn");
    assert.equal(slaState(base, at("2026-11-09T13:25:00Z")), "breached");
    assert.equal(slaState({ ...base, status: "pending", sla_paused_at: iso("2026-11-09T10:00:00Z") }, at("2026-11-09T12:50:00Z")), "paused");
    assert.equal(
      slaState({ ...base, status: "solved", first_replied_at: iso("2026-11-09T09:30:00Z"), solved_at: iso("2026-11-10T09:00:00Z") }, at("2026-11-12T00:00:00Z")),
      "met"
    );
    assert.equal(slaState({ ...base, first_reply_due: null, resolve_due: null }), null);
  });

  test("the queue's Due column reads like the preview", () => {
    assert.equal(dueLabel(base, at("2026-11-09T13:25:00Z"), "Europe/London"), "Reply overdue 25m");
    assert.equal(dueLabel(base, at("2026-11-09T11:40:00Z"), "Europe/London"), "Reply due in 1h 20m");
    assert.equal(dueLabel({ ...base, status: "pending", sla_paused_at: iso("2026-11-09T10:00:00Z") }, at("2026-11-09T11:00:00Z"), "Europe/London"), "Paused");
    const replied = { ...base, first_replied_at: iso("2026-11-09T09:20:00Z") };
    assert.equal(dueLabel(replied, at("2026-11-10T08:00:00Z"), "Europe/London"), "Resolve due tomorrow");
    assert.equal(dueLabel(replied, at("2026-11-09T09:30:00Z"), "Europe/London"), "Resolve due in 2d");
    assert.equal(dueLabel({ ...replied, resolve_due: iso("2026-11-09T14:30:00Z") }, at("2026-11-09T09:30:00Z"), "Europe/London"), "Reply met · resolve in 5h");
    assert.equal(dueLabel({ ...replied, status: "solved", solved_at: iso("2026-11-10T09:00:00Z") }, at("2026-11-12T00:00:00Z")), "Met");
    assert.equal(dueLabel({ ...base, first_reply_due: null, resolve_due: null }), "");
    // A calendar with no open hours: the clock never runs.
    const never = new Date(HD_NO_OPEN_HOURS_DUE).toISOString();
    assert.equal(dueLabel({ ...base, first_reply_due: never, resolve_due: never }, at("2026-11-09T10:00:00Z")), "No office hours");
    assert.equal(dueLabel({ ...replied, resolve_due: never }, at("2026-11-09T10:00:00Z")), "No office hours");
  });

  test("formatDuration", () => {
    assert.equal(formatDuration(25 * 60_000), "25m");
    assert.equal(formatDuration(80 * 60_000), "1h 20m");
    assert.equal(formatDuration(5 * 3_600_000), "5h");
    assert.equal(formatDuration(50 * 3_600_000), "2d 2h");
    assert.equal(formatDuration(5 * 86_400_000), "5d");
  });
});

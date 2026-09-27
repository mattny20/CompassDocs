// Scheduled exports — when a preset's email is due. Pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, isExportDue, sanitizeSchedule, stampSchedule, parseRecipientList } from "../src/lib/directory-export-schedule-rules";

const at = (s: string) => new Date(s);

describe("export schedule", () => {
  test("weekly: due from the chosen weekday and hour, once per week; a late restart still sends", () => {
    const s = sanitizeSchedule({ frequency: "weekly", day: 1, hour: 6, recipients: "it@f.com" }); // Mondays 06:00
    assert.equal(isExportDue(s, undefined, at("2026-09-28T05:59:00Z")), false, "Monday, before the hour");
    assert.equal(isExportDue(s, undefined, at("2026-09-28T06:00:00Z")), true, "Monday, on the hour");
    assert.equal(isExportDue(s, "2026-09-28T06:00:00Z", at("2026-09-28T09:00:00Z")), false, "already sent this week");
    assert.equal(isExportDue(s, "2026-09-28T06:00:00Z", at("2026-09-30T12:00:00Z")), false, "Wednesday, same week");
    assert.equal(isExportDue(s, "2026-09-28T06:00:00Z", at("2026-10-05T06:00:00Z")), true, "next Monday");
    assert.equal(isExportDue(s, "2026-09-21T06:00:00Z", at("2026-09-29T15:00:00Z")), true, "missed Monday's hour, Tuesday catches up");
  });

  test("monthly: due from the day of the month, once per month, wrapping the year", () => {
    const s = sanitizeSchedule({ frequency: "monthly", day: 1, hour: 6, recipients: ["ops@f.com"] });
    assert.equal(isExportDue(s, undefined, at("2026-10-01T05:00:00Z")), true, "never run, never stamped: the period that passed is owed");
    assert.equal(isExportDue(s, undefined, at("2026-10-01T06:00:00Z")), true);
    assert.equal(isExportDue(s, "2026-10-01T06:00:00Z", at("2026-10-20T06:00:00Z")), false);
    assert.equal(isExportDue(s, "2026-10-01T06:00:00Z", at("2026-11-01T06:00:00Z")), true);
    assert.equal(isExportDue(s, "2025-12-01T06:00:00Z", at("2026-01-01T07:00:00Z")), true, "January follows December");
    // Set on the 15th: nothing until the next 1st, then once.
    const set = { ...s, since: "2026-09-15T10:00:00Z" };
    assert.equal(isExportDue(set, undefined, at("2026-09-30T23:00:00Z")), false, "set mid-month: this month's slot already passed");
    assert.equal(isExportDue(set, undefined, at("2026-10-01T05:00:00Z")), false);
    assert.equal(isExportDue(set, undefined, at("2026-10-01T06:00:00Z")), true);
    assert.equal(isExportDue(set, "2026-10-01T06:00:00Z", at("2026-10-01T09:00:00Z")), false);
  });

  test("off, or no recipients, is never due; the sanitizer clamps days and hours", () => {
    assert.equal(isExportDue(sanitizeSchedule({ frequency: "weekly", recipients: "" }), undefined, at("2026-09-28T06:00:00Z")), false);
    assert.equal(isExportDue(sanitizeSchedule({ frequency: "off", recipients: "a@b.co" }), undefined, at("2026-09-28T06:00:00Z")), false);
    assert.deepEqual(sanitizeSchedule({ frequency: "monthly", day: 31, hour: 25, recipients: "A@B.co; a@b.co bad", format: "csv" }), { frequency: "monthly", day: 1, hour: 6, recipients: ["a@b.co"], format: "csv" });
    assert.deepEqual(sanitizeSchedule({ frequency: "weekly", day: 6, hour: 0 }), { frequency: "weekly", day: 6, hour: 0, recipients: [], format: "pdf" });
    assert.deepEqual(parseRecipientList(["x@y.z", "x@y.z"]), ["x@y.z"]);
  });

  test("stamping: a schedule turned on or moved starts from now; an unchanged one keeps its start; off drops it", () => {
    const now = at("2026-09-27T12:00:00Z");
    const on = sanitizeSchedule({ frequency: "weekly", day: 1, hour: 6, recipients: "a@b.co" });
    const stamped = stampSchedule(on, undefined, now);
    assert.equal(stamped.since, now.toISOString());
    assert.equal(stampSchedule(on, stamped, at("2026-09-28T12:00:00Z")).since, now.toISOString(), "unchanged keeps the stamp");
    assert.equal(stampSchedule({ ...on, hour: 7 }, stamped, at("2026-09-28T12:00:00Z")).since, "2026-09-28T12:00:00.000Z", "moved restarts");
    assert.equal(stampSchedule({ ...on, recipients: ["c@d.co"] }, stamped, at("2026-09-28T12:00:00Z")).since, now.toISOString(), "recipients alone do not restart");
    assert.equal(stampSchedule({ ...on, frequency: "off" }, stamped, now).since, undefined);
  });

  test("describes itself", () => {
    assert.equal(describeSchedule(sanitizeSchedule({ frequency: "weekly", day: 5, hour: 17 })), "Every Friday at 17:00 UTC");
    assert.equal(describeSchedule(sanitizeSchedule({ frequency: "monthly", day: 22, hour: 6 })), "On the 22nd of every month at 06:00 UTC");
    assert.equal(describeSchedule(sanitizeSchedule({ frequency: "monthly", day: 3, hour: 6 })), "On the 3rd of every month at 06:00 UTC");
    assert.equal(describeSchedule(sanitizeSchedule({})), "Not scheduled");
  });
});

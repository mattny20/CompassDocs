// A calendar day prints as the day it is (G1, 1.12.0). ack_effective_at is a
// `date` column ('YYYY-MM-DD') and a next re-confirmation date is the
// midnight UTC of the day a manager chose on a date input; neither is an
// instant, so projecting either into the workspace time zone would print
// the day before for every zone west of UTC (New York reads '2026-01-01' as
// 31 Dec 2025). formatDay pins both to UTC and keeps the workspace date
// format; the card, the popover, the portal and the Settings tab's inputs
// then name the same day. Pure, so no database.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/format-day.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatDay } from "../src/lib/format";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";

const newYork = { ...SETTINGS_DEFAULTS, timezone: "America/New_York" };

test("'2026-01-01' in America/New_York is 1 Jan 2026, not the day before", () => {
  assert.equal(formatDay("2026-01-01", newYork), "Jan 1, 2026");
  // The instant formatter shifts it: the hazard formatDay exists for.
  assert.equal(formatDate("2026-01-01", newYork), "Dec 31, 2025");
});

test("an ISO instant at midnight UTC (a chosen next date) prints the same day", () => {
  assert.equal(formatDay("2026-01-01T00:00:00.000Z", newYork), "Jan 1, 2026");
  assert.equal(formatDay("2026-01-01T00:00:00Z", { ...newYork, timezone: "Pacific/Auckland" }), "Jan 1, 2026");
});

test("the workspace date format is kept, pinned to UTC in every one", () => {
  assert.equal(formatDay("2026-01-01", { ...newYork, date_format: "iso" }), "2026-01-01");
  assert.equal(formatDay("2026-01-01", { ...newYork, date_format: "long" }), "January 1, 2026");
  assert.equal(formatDay("2026-01-01", { ...newYork, date_format: "us" }), "01/01/2026");
  assert.equal(formatDay("2026-01-01", { ...newYork, date_format: "eu" }), "01/01/2026");
});

test("nothing, and an unparsable value, print as nothing", () => {
  assert.equal(formatDay(null, newYork), "");
  assert.equal(formatDay(undefined, newYork), "");
  assert.equal(formatDay("", newYork), "");
  assert.equal(formatDay("not a day", newYork), "");
});

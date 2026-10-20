// Deadlines (E1, 1.13.0): the policy -> space -> workspace -> built-in
// cascade and where each value comes from; a fixed date wins while it is
// still ahead and falls back to the relative rule once it has passed; a
// fixed day ends at midnight in the workspace's zone; overdue_grace_days
// delays the overdue state; "Also move existing deadlines" recomputes the
// open rows, keeps the last ten moves on due_history and leaves exempt and
// removed rows alone; a re-confirmation cycle restarts every open row's
// clock from the cascade; the Program settings and space validation; and
// the email's due tags, filled from each recipient's own row.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-due.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  pool,
  getSetting,
  setSetting,
  createDocument,
  updateSpace,
  getSpaceById,
  claimDueRecertifications,
  moveDeadlines,
  policyDefaultLayers,
  assignmentDueDates,
  dueAtSql,
  dueRearmSql,
} from "../src/lib/db";
import {
  resolvePolicyDefaults,
  workspaceDueDefaults,
  movePolicyDeadlines,
  notifyAckRequest,
  noticeCopy,
} from "../src/lib/compliance";
import type { Mailer } from "../src/lib/compliance";
import { renderEmail } from "../src/lib/email-templates";
import { getAppSettings } from "../src/lib/settings-store";
import { formatDate } from "../src/lib/format";
import {
  COMPLIANCE_DEFAULTS,
  parseComplianceSettingsPatch,
  readComplianceSettings,
  saveComplianceSettings,
} from "../src/lib/compliance-settings";
import {
  BUILT_IN,
  DUE_NUMBER_KEYS,
  DUE_FIELDS,
  DUE_HISTORY_MAX,
  DUE_RANGES,
  resolveDefaults,
  dueAtFor,
  endOfDayIn,
  parseYmd,
  isOverdue,
  daysLeft,
  parsePolicyDefaultsPatch,
  sanitizeLayer,
  mergeLayer,
  diffLayers,
  dueNumberError,
  dueRuleLabel,
  inheritLabel,
  audienceDueHelper,
  portalDueLine,
  dueChip,
  dueStickyLabel,
  overdueConfirmCopy,
  dueLineFor,
  dueSuffixFor,
} from "../src/lib/ack-due";
import type { DueHistoryEntry } from "../src/lib/ack-due";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackdue-${Date.now()}`;
const DAY = 86_400_000;
const ORIGIN = "https://docs.example.test";
const actor = { id: null, name: STAMP };
const fmt = (iso: string) => iso.slice(0, 10);

/** Two timestamps as instants: a value inside due_history is rendered by Postgres's JSON serialiser (microseconds, +00:00), a column by the pg parser (milliseconds, Z). */
function assertSameInstant(actual: string | null, expected: string | null, label: string) {
  assert.ok(actual && expected, `${label}: both dates are set`);
  assert.equal(new Date(actual!).toISOString(), new Date(expected!).toISOString(), label);
}

/** |a - b| within `ms`. */
function assertNear(actual: string | Date | null, expected: Date, ms: number, label: string) {
  assert.ok(actual, `${label}: a date is set`);
  const diff = Math.abs(new Date(actual!).getTime() - expected.getTime());
  assert.ok(diff <= ms, `${label}: ${new Date(actual!).toISOString()} is within ${ms}ms of ${expected.toISOString()} (off by ${diff}ms)`);
}

/** 'YYYY-MM-DD' `days` from now (UTC). */
const ymdFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

// --- Pure ---------------------------------------------------------------------------

describe("the cascade (pure)", () => {
  test("policy -> space -> workspace -> built-in, each value with its origin; the owner has no workspace layer", () => {
    const r = resolveDefaults({
      policy: { due_days: 5, owner_user_id: 7 },
      space: { due_days: 9, remind_every_days: 3, owner_user_id: 8 },
      workspace: { due_days: 21, remind_every_days: 10, nudge_every_days: 30 },
    });
    assert.equal(r.values.due_days, 5);
    assert.equal(r.origin.due_days, "policy");
    assert.equal(r.values.remind_every_days, 3);
    assert.equal(r.origin.remind_every_days, "space");
    assert.equal(r.values.nudge_every_days, 30);
    assert.equal(r.origin.nudge_every_days, "workspace");
    assert.equal(r.values.escalate_after_days, BUILT_IN.escalate_after_days);
    assert.equal(r.origin.escalate_after_days, "built-in");
    assert.equal(r.values.owner_user_id, 7);
    assert.equal(r.origin.owner_user_id, "policy");

    const noPolicy = resolveDefaults({ space: { owner_user_id: 8 }, workspace: { due_days: 21 } });
    assert.equal(noPolicy.values.owner_user_id, 8);
    assert.equal(noPolicy.origin.owner_user_id, "space");
    assert.equal(noPolicy.values.due_days, 21);

    const nothing = resolveDefaults({});
    assert.deepEqual(nothing.values, { ...BUILT_IN, owner_user_id: null });
    for (const key of [...DUE_NUMBER_KEYS, "owner_user_id"] as const) assert.equal(nothing.origin[key], "built-in", key);
  });

  test("a junk value at a layer is skipped, never applied: 0 days, 400 days, a string, a negative owner", () => {
    const r = resolveDefaults({
      policy: { due_days: 0, owner_user_id: -1 },
      space: { due_days: 400, remind_before_days: "3" as unknown as number },
      workspace: { due_days: 21, remind_before_days: 2 },
    });
    assert.equal(r.values.due_days, 21, "0 and 400 are not days; the workspace's 21 applies");
    assert.equal(r.origin.due_days, "workspace");
    assert.equal(r.values.remind_before_days, 2);
    assert.equal(r.values.owner_user_id, null);
    assert.equal(r.origin.owner_user_id, "built-in");
    assert.deepEqual(sanitizeLayer({ due_days: 14, nudge_every_days: 0, overdue_grace_days: 90, bogus: 1, owner_user_id: 3 }), {
      due_days: 14,
      nudge_every_days: 0,
      overdue_grace_days: 90,
      owner_user_id: 3,
    });
    assert.deepEqual(sanitizeLayer(null), {});
    assert.deepEqual(sanitizeLayer([1]), {});
  });

  test("mergeLayer: null clears a key (inherit), a number sets it; diffLayers names what moved", () => {
    const base = { due_days: 9, remind_every_days: 3, owner_user_id: 8 };
    const next = mergeLayer(base, { due_days: null, nudge_every_days: 30, owner_user_id: undefined });
    assert.deepEqual(next, { remind_every_days: 3, owner_user_id: 8, nudge_every_days: 30 });
    assert.deepEqual(diffLayers(base, next), [
      { key: "due_days", from: 9, to: null },
      { key: "nudge_every_days", from: null, to: 30 },
    ]);
    assert.deepEqual(diffLayers(base, base), []);
  });
});

describe("due dates (pure)", () => {
  test("a fixed day ends at midnight in the workspace's zone: UTC, Berlin in winter and summer, New York", () => {
    assert.equal(endOfDayIn("2026-10-29")!.toISOString(), "2026-10-29T23:59:59.999Z");
    assert.equal(endOfDayIn("2026-10-29", "UTC")!.toISOString(), "2026-10-29T23:59:59.999Z");
    // Berlin: DST ended on 25 Oct 2026, so 29 Oct is UTC+1; 1 Jul is UTC+2.
    assert.equal(endOfDayIn("2026-10-29", "Europe/Berlin")!.toISOString(), "2026-10-29T22:59:59.999Z");
    assert.equal(endOfDayIn("2026-07-01", "Europe/Berlin")!.toISOString(), "2026-07-01T21:59:59.999Z");
    // New York on 29 Oct is EDT (UTC-4): the day ends after 3:59 UTC the next morning.
    assert.equal(endOfDayIn("2026-10-29", "America/New_York")!.toISOString(), "2026-10-30T03:59:59.999Z");
    // An ISO timestamp is read by its day; anything else is not a day.
    assert.equal(endOfDayIn("2026-10-29T10:00:00Z")!.toISOString(), "2026-10-29T23:59:59.999Z");
    assert.equal(endOfDayIn("2026-02-31"), null, "February has no 31st");
    assert.equal(endOfDayIn("next week"), null);
    assert.equal(endOfDayIn(null), null);
    assert.deepEqual(parseYmd("2026-10-29"), [2026, 10, 29]);
    // An unknown zone reads as UTC rather than throwing in a sweep.
    assert.equal(endOfDayIn("2026-10-29", "Mars/Olympus_Mons")!.toISOString(), "2026-10-29T23:59:59.999Z");
  });

  test("dueAtFor: the fixed date while it is still ahead, else from + due_days, else null", () => {
    const from = new Date("2026-10-20T10:00:00Z");
    assert.equal(dueAtFor({ due_days: 14 }, { from, fixed: "2026-10-29" })!.toISOString(), "2026-10-29T23:59:59.999Z", "the fixed date, ahead");
    assert.equal(
      dueAtFor({ due_days: 14 }, { from, fixed: "2026-10-20" })!.toISOString(),
      "2026-10-20T23:59:59.999Z",
      "a fixed date of today is still ahead until the day ends"
    );
    assert.equal(dueAtFor({ due_days: 14 }, { from, fixed: "2026-10-19" })!.toISOString(), "2026-11-03T10:00:00.000Z", "a fixed date in the past: the relative rule");
    assert.equal(dueAtFor({ due_days: 14 }, { from })!.toISOString(), "2026-11-03T10:00:00.000Z", "no fixed date: the relative rule");
    assert.equal(dueAtFor({ due_days: 14 }, { from, fixed: "2026-10-29", timeZone: "America/New_York" })!.toISOString(), "2026-10-30T03:59:59.999Z");
    assert.equal(dueAtFor({ due_days: null }, { from }), null, "no number of days anywhere: no due date");
    assert.equal(dueAtFor({ due_days: 0 }, { from }), null);
  });

  test("daysLeft counts calendar days in the zone: 0 on the due day, negative after it, whatever the time of day", () => {
    const now = new Date("2026-10-20T22:30:00Z");
    assert.equal(daysLeft("2026-10-29T23:59:59.999Z", now), 9);
    assert.equal(daysLeft("2026-10-20T23:59:59.999Z", now), 0);
    assert.equal(daysLeft("2026-10-19T23:59:59.999Z", now), -1);
    assert.equal(daysLeft(new Date(now.getTime() + 14 * DAY), now), 14, "a due date set 14 days out reads as 14 the day it is set");
    // 22:30 UTC on 20 Oct is already 21 Oct in Tokyo: the due day of 29 Oct (Tokyo) is 8 days away there.
    assert.equal(daysLeft("2026-10-29T14:59:59.999Z", now, "Asia/Tokyo"), 8);
  });

  test("overdue = due date + grace passed and no current confirmation; a confirmed row or one without a date never is", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    const due = "2026-10-20T23:59:59.999Z";
    assert.equal(isOverdue({ due_at: due }, { overdue_grace_days: 0 }, now), true);
    assert.equal(isOverdue({ due_at: due }, { overdue_grace_days: 4 }, now), true, "4 days of grace ended at midnight on the 24th");
    assert.equal(isOverdue({ due_at: due }, { overdue_grace_days: 5 }, now), false, "5 days of grace runs until midnight on the 25th");
    assert.equal(isOverdue({ due_at: due, acknowledged_at: "2026-10-22T09:00:00Z" }, { overdue_grace_days: 0 }, now), false, "confirmed");
    assert.equal(isOverdue({ due_at: null }, { overdue_grace_days: 0 }, now), false, "no due date");
    assert.equal(isOverdue({ due_at: "2026-10-25T12:00:00.001Z" }, { overdue_grace_days: 0 }, now), false, "a millisecond ahead");
    assert.equal(isOverdue({ due_at: "not a date" }, { overdue_grace_days: 0 }, now), false);
  });
});

describe("validation (pure)", () => {
  test("parsePolicyDefaultsPatch: the ranges as contracted, null to inherit, unknown keys refused, the owner only where a layer has one", () => {
    const refused = (body: unknown, fragment: string, opts?: { owner?: boolean; prefix?: string }) => {
      const r = parsePolicyDefaultsPatch(body, opts);
      assert.equal(r.ok, false, `${JSON.stringify(body)} should be refused`);
      if (!r.ok) assert.match(r.error, new RegExp(fragment), `${JSON.stringify(body)}: ${r.error}`);
    };
    refused({ due_days: 0 }, "from 1 to 365 days");
    refused({ due_days: 366 }, "from 1 to 365 days");
    refused({ due_days: 1.5 }, "whole number");
    refused({ due_days: "14" }, "whole number");
    refused({ overdue_grace_days: 91 }, "from 0 to 90 days");
    refused({ overdue_grace_days: -1 }, "from 0 to 90 days");
    refused({ nudge_every_days: 366 }, "from 0 to 365 days");
    refused({ remind_before_days: 0 }, "from 1 to 365 days");
    refused({ cooldown_hours: 2 }, 'Unknown setting "cooldown_hours"');
    refused({ owner_user_id: 3 }, 'Unknown setting "owner_user_id"', { owner: false });
    refused({ owner_user_id: "me" }, "must be a user id", { owner: true });
    refused({ owner_user_id: 0 }, "must be a user id", { owner: true });
    refused(null, '"policy_defaults" must be an object');
    refused([], "must be an object");
    refused({ due_days: 0 }, '"ack_defaults.due_days" must be', { prefix: "ack_defaults." });
    refused("x", '"ack_defaults" must be an object', { prefix: "ack_defaults." });

    const ok = parsePolicyDefaultsPatch(
      { due_days: 30, overdue_grace_days: 0, nudge_every_days: 0, remind_every_days: null, owner_user_id: 42 },
      { owner: true }
    );
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.patch, { due_days: 30, overdue_grace_days: 0, nudge_every_days: 0, remind_every_days: null, owner_user_id: 42 });
    const none = parsePolicyDefaultsPatch({}, { owner: true });
    assert.equal(none.ok, true);
    if (none.ok) assert.deepEqual(none.patch, {});
    for (const key of DUE_NUMBER_KEYS) {
      const { min, max } = DUE_RANGES[key];
      assert.equal(parsePolicyDefaultsPatch({ [key]: min }).ok, true, `${key} ${min}`);
      assert.equal(parsePolicyDefaultsPatch({ [key]: max }).ok, true, `${key} ${max}`);
      assert.equal(parsePolicyDefaultsPatch({ [key]: null }).ok, true, `${key} null`);
      assert.match(dueNumberError(key), new RegExp(`built-in \\(${BUILT_IN[key]}\\)`));
    }
  });

  test("program settings: the seven numbers ride on ack_defaults, validated the same way; a stored junk value reads as unset", () => {
    const ok = parseComplianceSettingsPatch({ ack_defaults: { due_days: 21, nudge_every_days: 0, overdue_grace_days: null } });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.patch, { ack_defaults: { due_days: 21, nudge_every_days: 0, overdue_grace_days: null } });
    const refused = (body: unknown, fragment: string) => {
      const r = parseComplianceSettingsPatch(body);
      assert.equal(r.ok, false, `${JSON.stringify(body)} should be refused`);
      if (!r.ok) assert.match(r.error, new RegExp(fragment));
    };
    refused({ ack_defaults: { due_days: 0 } }, '"ack_defaults.due_days" must be a whole number from 1 to 365 days');
    refused({ ack_defaults: { overdue_grace_days: 91 } }, "from 0 to 90 days");
    refused({ ack_defaults: { remind_every_days: "7" } }, "whole number");
    refused({ ack_defaults: { owner_user_id: 3 } }, 'Unknown setting "ack_defaults.owner_user_id"');
    for (const key of DUE_NUMBER_KEYS) assert.equal(COMPLIANCE_DEFAULTS.ack_defaults[key], null, `${key} starts unset`);
  });

  test("the card's seven fields cover the seven keys in order, with sentences and no dashes", () => {
    assert.deepEqual(
      DUE_FIELDS.map((f) => f.key),
      [...DUE_NUMBER_KEYS]
    );
    for (const f of DUE_FIELDS) {
      assert.ok(f.label.length > 3 && f.help.endsWith("."), `${f.key}: a label and a help sentence`);
      assert.doesNotMatch(`${f.label} ${f.help}`, /[–—]/, `${f.key}: no dashes`);
    }
  });
});

describe("copy (pure)", () => {
  const resolved = resolveDefaults({ space: { due_days: 10 } });
  const now = new Date("2026-10-20T12:00:00Z");

  test("the rule in words, the inherit label with its origin, the helper line, the portal line", () => {
    assert.equal(dueRuleLabel({ due_days: 30, due_at: null }, resolved.values, fmt), "30 days after assignment");
    assert.equal(dueRuleLabel({ due_days: null, due_at: null }, resolved.values, fmt), "10 days after assignment");
    assert.equal(dueRuleLabel({ due_days: 1, due_at: null }, resolved.values, fmt), "1 day after assignment");
    assert.equal(dueRuleLabel({ due_days: null, due_at: "2026-10-29" }, resolved.values, fmt), "2026-10-29");
    assert.equal(dueRuleLabel(null, { due_days: 14 }, fmt), "14 days after assignment");
    assert.equal(inheritLabel(resolved, "Security"), "Inherit (10 days, from Security)");
    assert.equal(inheritLabel(resolveDefaults({ workspace: { due_days: 21 } }), "Security"), "Inherit (21 days, the workspace default)");
    assert.equal(inheritLabel(resolveDefaults({}), "Security"), "Inherit (14 days, built-in)");
    assert.equal(
      audienceDueHelper({ due_days: null, due_at: "2026-10-29" }, resolved.values, fmt),
      "Current audience: due 2026-10-29 · new joiners: 14 days after they join"
    );
    assert.equal(
      audienceDueHelper(null, resolved.values, fmt),
      "Current audience: due 10 days after assignment · new joiners: 14 days after they join"
    );
    assert.equal(portalDueLine({ due_days: null, due_at: "2026-10-29" }, resolved.values, 12, fmt), "Due 2026-10-29 · 12 overdue");
    assert.equal(portalDueLine(null, resolved.values, 0, fmt), "Due 10 days after assignment");
  });

  test("the chips: neutral beyond three days, warn at three or fewer, error once overdue (after the grace), nothing when confirmed", () => {
    const g = { overdue_grace_days: 0 };
    assert.deepEqual(dueChip({ due_at: "2026-10-29T23:59:59.999Z" }, g, fmt, now), { tone: "neutral", label: "Due 2026-10-29" });
    assert.deepEqual(dueChip({ due_at: "2026-10-23T23:59:59.999Z" }, g, fmt, now), { tone: "warn", label: "Due 2026-10-23" });
    assert.deepEqual(dueChip({ due_at: "2026-10-20T23:59:59.999Z" }, g, fmt, now), { tone: "warn", label: "Due 2026-10-20" });
    assert.deepEqual(dueChip({ due_at: "2026-10-19T23:59:59.999Z" }, g, fmt, now), { tone: "error", label: "Overdue since 2026-10-19" });
    assert.deepEqual(dueChip({ due_at: "2026-10-19T23:59:59.999Z" }, { overdue_grace_days: 3 }, fmt, now), { tone: "warn", label: "Due 2026-10-19" });
    assert.equal(dueChip({ due_at: "2026-10-19T23:59:59.999Z", acknowledged_at: "2026-10-20T09:00:00Z" }, g, fmt, now), null);
    assert.equal(dueChip({ due_at: null }, g, fmt, now), null);
    assert.equal(dueStickyLabel({ due_at: "2026-10-22T23:59:59.999Z" }, g, now), "Due in 2 days");
    assert.equal(dueStickyLabel({ due_at: "2026-10-21T23:59:59.999Z" }, g, now), "Due tomorrow");
    assert.equal(dueStickyLabel({ due_at: "2026-10-20T23:59:59.999Z" }, g, now), "Due today");
    assert.equal(dueStickyLabel({ due_at: "2026-10-19T23:59:59.999Z" }, g, now), "Overdue");
    assert.equal(dueStickyLabel({ due_at: null }, g, now), null);
    assert.equal(overdueConfirmCopy("2026-10-19T23:59:59.999Z", fmt), "This was due 2026-10-19. Confirming now still records today's date.");
    assert.equal(dueLineFor("2026-10-29T23:59:59.999Z", fmt), "Please confirm by 2026-10-29.");
    assert.equal(dueLineFor(null, fmt), "");
    assert.equal(dueSuffixFor("2026-10-29T23:59:59.999Z", fmt), " by 2026-10-29");
    assert.equal(dueSuffixFor("", fmt), "");
    assert.equal(noticeCopy({ mode: "request", docTitle: "T", actorName: "A", dueAt: "2026-10-29T23:59:59.999Z", dueText: "29 Oct 2026" }).body, 'Please read and confirm "T" by 29 Oct 2026.');
    assert.equal(noticeCopy({ mode: "reminder", docTitle: "T", actorName: "A" }).body, 'You still need to read and confirm "T".');
  });
});

// --- Against the database ------------------------------------------------------------

/**
 * The settings row is shared (test/compliance-settings.test.ts and the A5
 * describe of test/ack-revision.test.ts write ack_defaults, which the
 * workspace layer reads), and node:test runs files in parallel: one
 * advisory lock, held on a dedicated connection for the length of the
 * database describes, keeps the files from reading each other's values.
 */
const SETTINGS_LOCK = 728342;
let lockClient: PoolClient | null = null;
let savedDefaults: string | undefined;

let spaceId = 0;
let readerA = 0;
let readerB = 0;
let readerC = 0;
const userIds: number[] = [];
const docIds: number[] = [];

const TEXT = Array.from({ length: 12 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

async function newUser(tag: string): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `Due ${tag}`, `${STAMP}-${tag}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

/** A published policy that requires confirmation. The requirement is set by SQL, not setAckRequired, so no audience reconcile enrols the whole workspace: the rows are this file's. */
async function newPolicy(title: string): Promise<{ id: number; title: string }> {
  const full = `${STAMP} ${title}`;
  const doc = await createDocument({ space_id: spaceId, title: full, type: "policy", status: "published", content: TEXT, summary: "", tags: [], author: "test" });
  await pool().query("UPDATE documents SET ack_required = 1 WHERE id = $1", [doc.id]);
  docIds.push(doc.id);
  return { id: doc.id, title: full };
}

interface AssignRow {
  id: number;
  user_id: number;
  due_at: string | null;
  cycle_started_at: string;
  reminded_at: string | null;
  escalated_at: string | null;
  exempt_at: string | null;
  removed_at: string | null;
  due_history: DueHistoryEntry[];
}

/** One assignment row, written by hand (the audience agent's reconcile is not under test here). */
async function assign(
  docId: number,
  userId: number,
  o: { cycleAgoDays?: number; dueInDays?: number | null; reminded?: boolean; escalated?: boolean; exempt?: boolean; removed?: boolean } = {}
): Promise<AssignRow> {
  const r = await fixtureQuery(
    `INSERT INTO policy_assignments (document_id, user_id, source, assigned_at, cycle_started_at, due_at, reminded_at, escalated_at, exempt_at, removed_at)
     VALUES ($1, $2, 'manual', now() - make_interval(days => $3), now() - make_interval(days => $3),
             CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END,
             CASE WHEN $5::boolean THEN now() - interval '1 day' END,
             CASE WHEN $6::boolean THEN now() - interval '1 hour' END,
             CASE WHEN $7::boolean THEN now() END,
             CASE WHEN $8::boolean THEN now() END)
     ON CONFLICT (document_id, user_id) DO UPDATE
       SET source = EXCLUDED.source, assigned_at = EXCLUDED.assigned_at, cycle_started_at = EXCLUDED.cycle_started_at,
           due_at = EXCLUDED.due_at, reminded_at = EXCLUDED.reminded_at, escalated_at = EXCLUDED.escalated_at,
           exempt_at = EXCLUDED.exempt_at, removed_at = EXCLUDED.removed_at, due_history = '[]'
     RETURNING id`,
    [docId, userId, o.cycleAgoDays ?? 0, o.dueInDays === undefined ? 14 : o.dueInDays, Boolean(o.reminded), Boolean(o.escalated), Boolean(o.exempt), Boolean(o.removed)]
  );
  return (await assignRow(r.rows[0].id))!;
}

async function assignRow(id: number): Promise<AssignRow | undefined> {
  const r = await pool().query<AssignRow>(
    "SELECT id, user_id, due_at, cycle_started_at, reminded_at, escalated_at, exempt_at, removed_at, due_history FROM policy_assignments WHERE id = $1",
    [id]
  );
  return r.rows[0];
}

const setPolicyRule = (docId: number, rule: { due_days?: number | null; due_at?: string | null; owner?: number | null }) =>
  pool().query(
    `INSERT INTO policy_settings (document_id, due_days, due_at, owner_user_id) VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (document_id) DO UPDATE SET due_days = EXCLUDED.due_days, due_at = EXCLUDED.due_at, owner_user_id = EXCLUDED.owner_user_id`,
    [docId, rule.due_days ?? null, rule.due_at ?? null, rule.owner ?? null]
  );

const auditRows = async (action: string, targetId: string) =>
  (
    await pool().query<{ actor_name: string; details: Record<string, unknown> }>(
      "SELECT actor_name, details FROM audit_log WHERE action = $1 AND target_id = $2 AND actor_name = $3 ORDER BY id",
      [action, targetId, STAMP]
    )
  ).rows;

before(async () => {
  await getSetting("__schema_bootstrap__");
  const client = await pool().connect();
  await client.query("SELECT pg_advisory_lock($1)", [SETTINGS_LOCK]);
  lockClient = client;
  savedDefaults = await getSetting("ack_defaults");
  await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");

  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Due ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  readerA = await newUser("Reader A");
  readerB = await newUser("Reader B");
  readerC = await newUser("Reader C");
});

after(async () => {
  await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
  if (savedDefaults !== undefined) await setSetting("ack_defaults", savedDefaults);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM policy_assignments WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM policy_settings WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_name = $1", [STAMP]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SETTINGS_LOCK]).catch(() => {});
    lockClient.release();
  }
});

describe("the cascade from the database", () => {
  test("resolvePolicyDefaults reads the three layers with their origins; the workspace layer is audited as ack.defaults_set scope workspace", async () => {
    const { id } = await newPolicy("cascade");
    let r = await resolvePolicyDefaults(id);
    assert.deepEqual(r.values, { ...BUILT_IN, owner_user_id: null }, "nothing set anywhere: the built-ins");
    assert.ok(Object.values(r.origin).every((o) => o === "built-in"));
    assert.deepEqual(r.space, { id: spaceId, name: `Ack Due ${STAMP}` });
    assert.deepEqual(r.rule, { due_days: null, due_at: null }, "no policy_settings row yet: inherit");
    assert.deepEqual(await workspaceDueDefaults(), {});

    // The workspace layer: Program settings.
    const saved = await saveComplianceSettings({ ack_defaults: { due_days: 21, nudge_every_days: 30 } }, { actor });
    assert.deepEqual(saved.changes, [
      { key: "ack_defaults.due_days", from: null, to: 21 },
      { key: "ack_defaults.nudge_every_days", from: null, to: 30 },
    ]);
    assert.deepEqual(await workspaceDueDefaults(), { due_days: 21, nudge_every_days: 30 });
    const audit = await auditRows("ack.defaults_set", "ack_defaults.due_days");
    assert.equal(audit.length, 1, "one ack.defaults_set row for the key");
    assert.deepEqual(audit[0].details, { scope: "workspace", space_id: null, key: "due_days", from: null, to: 21 });
    assert.equal((await auditRows("settings.compliance", "ack_defaults.due_days")).length, 0, "not a settings.compliance row");
    r = await resolvePolicyDefaults(id);
    assert.equal(r.values.due_days, 21);
    assert.equal(r.origin.due_days, "workspace");
    assert.equal(r.values.nudge_every_days, 30);
    assert.equal(r.values.remind_every_days, BUILT_IN.remind_every_days);

    // The space layer: stored whole, read back parsed, junk skipped.
    const space = await updateSpace(spaceId, { policy_defaults: { due_days: 9, remind_every_days: 3, owner_user_id: readerB } });
    assert.deepEqual(space?.policy_defaults, { due_days: 9, remind_every_days: 3, owner_user_id: readerB });
    assert.deepEqual((await getSpaceById(spaceId))?.policy_defaults, { due_days: 9, remind_every_days: 3, owner_user_id: readerB });
    r = await resolvePolicyDefaults(id);
    assert.equal(r.values.due_days, 9);
    assert.equal(r.origin.due_days, "space");
    assert.equal(r.values.remind_every_days, 3);
    assert.equal(r.origin.remind_every_days, "space");
    assert.equal(r.values.owner_user_id, readerB);
    assert.equal(r.origin.owner_user_id, "space");
    assert.equal(r.values.nudge_every_days, 30, "the workspace still fills what the space leaves");
    assert.equal(r.origin.nudge_every_days, "workspace");

    // The policy layer.
    await setPolicyRule(id, { due_days: 5, owner: readerA });
    r = await resolvePolicyDefaults(id);
    assert.equal(r.values.due_days, 5);
    assert.equal(r.origin.due_days, "policy");
    assert.equal(r.values.owner_user_id, readerA);
    assert.equal(r.origin.owner_user_id, "policy");
    assert.deepEqual(r.rule, { due_days: 5, due_at: null });
    await setPolicyRule(id, { due_at: "2027-06-30" });
    assert.deepEqual((await resolvePolicyDefaults(id)).rule, { due_days: null, due_at: "2027-06-30" }, "a fixed date reads as its day");
    const layers = await policyDefaultLayers(id);
    assert.deepEqual(layers?.policy, {}, "a policy row with nothing set is an empty layer");

    // updateSpace stores only values in range; a hand edit of junk reads as unset.
    await updateSpace(spaceId, { policy_defaults: { due_days: 400, remind_every_days: 3 } as never });
    assert.deepEqual((await getSpaceById(spaceId))?.policy_defaults, { remind_every_days: 3 });
    await pool().query(`UPDATE spaces SET policy_defaults = '{"due_days": 0, "remind_every_days": "x", "owner_user_id": -4}' WHERE id = $1`, [spaceId]);
    r = await resolvePolicyDefaults(id);
    assert.equal(r.values.due_days, 21, "0 is skipped: the workspace's 21");
    assert.equal(r.values.remind_every_days, BUILT_IN.remind_every_days);
    assert.equal(r.values.owner_user_id, null);

    await updateSpace(spaceId, { policy_defaults: {} });
    await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
    assert.deepEqual((await readComplianceSettings()).ack_defaults.due_days, null);
    // A stored value out of range reads as unset.
    await setSetting("ack_defaults", JSON.stringify({ due_days: 400, overdue_grace_days: 7 }));
    const s = await readComplianceSettings();
    assert.equal(s.ack_defaults.due_days, null);
    assert.equal(s.ack_defaults.overdue_grace_days, 7);
    await pool().query("DELETE FROM settings WHERE key = 'ack_defaults'");
    assert.equal((await resolvePolicyDefaults(-1)).space, null, "a document that is gone resolves without a space");
  });
});

describe("moving deadlines", () => {
  test("Also move existing deadlines recomputes the open rows from their cycle start, writes due_history, clears a stale escalation, skips exempt and removed rows, and is audited ack.due_moved", async () => {
    const doc = await newPolicy("move");
    const a = await assign(doc.id, readerA, { cycleAgoDays: 2, dueInDays: 12, escalated: true });
    const b = await assign(doc.id, readerB, { cycleAgoDays: 10, dueInDays: 4 });
    const exempt = await assign(doc.id, readerC, { cycleAgoDays: 2, exempt: true });
    const settings = await getAppSettings();

    const r = await movePolicyDeadlines(doc, { due_days: 30, due_at: null }, { fromRule: { due_days: null, due_at: null }, actor });
    assert.equal(r.moved, 2, "the two open rows");
    assert.deepEqual([...r.ids].sort(), [a.id, b.id].sort());
    const a2 = (await assignRow(a.id))!;
    assertNear(a2.due_at, new Date(new Date(a.cycle_started_at).getTime() + 30 * DAY), 5_000, "A: cycle start + 30 days");
    assert.equal(a2.escalated_at, null, "the escalation stamp is cleared: the new date is ahead");
    assert.equal(a2.due_history.length, 1);
    assert.equal(a2.due_history[0].kind, "moved", "a rule move is never undone as an extension");
    assertSameInstant(a2.due_history[0].from, a.due_at, "history: from the old date");
    assertSameInstant(a2.due_history[0].to, a2.due_at, "history: to the new date");
    assert.equal(a2.due_history[0].by, null);
    assert.equal(a2.due_history[0].reason, "Deadline rule changed to 30 days after assignment");
    assert.ok(Date.now() - new Date(a2.due_history[0].at).getTime() < 60_000);
    const b2 = (await assignRow(b.id))!;
    assertNear(b2.due_at, new Date(new Date(b.cycle_started_at).getTime() + 30 * DAY), 5_000, "B: cycle start + 30 days");
    assert.deepEqual(await assignRow(exempt.id), exempt, "the exempt row is untouched");
    const audit = await auditRows("ack.due_moved", String(doc.id));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.policy, doc.id);
    assert.equal(audit[0].details.n, 2);
    assert.deepEqual(audit[0].details.from_rule, { due_days: null, due_at: null });
    assert.deepEqual(audit[0].details.to_rule, { due_days: 30, due_at: null });

    // The same rule again moves nothing and writes no history.
    const again = await movePolicyDeadlines(doc, { due_days: 30, due_at: null }, { actor });
    assert.equal(again.moved, 0);
    assert.equal((await assignRow(a.id))!.due_history.length, 1);

    // A fixed date ahead: every open row ends on that day in the workspace's zone.
    const fixed = ymdFromNow(40);
    const moved = await movePolicyDeadlines(doc, { due_days: null, due_at: fixed }, { actor });
    assert.equal(moved.moved, 2);
    const a3 = (await assignRow(a.id))!;
    assert.equal(a3.due_at, endOfDayIn(fixed, settings.timezone)!.toISOString());
    assert.equal((await assignRow(b.id))!.due_at, a3.due_at);
    assert.equal(a3.due_history.length, 2);
    assert.equal(a3.due_history[1].reason, "Deadline set to a fixed date");

    // A fixed date already past: the relative rule, with the inherited number of days (the built-in 14: nothing set above).
    const past = await movePolicyDeadlines(doc, { due_days: null, due_at: ymdFromNow(-1) }, { actor });
    assert.equal(past.moved, 2);
    assertNear((await assignRow(a.id))!.due_at, new Date(new Date(a.cycle_started_at).getTime() + 14 * DAY), 5_000, "A: cycle start + the built-in 14");

    // A removed row is never moved; a row whose new date is already past keeps its escalation stamp.
    const removed = await assign(doc.id, readerC, { cycleAgoDays: 2, removed: true });
    const stale = await assign(doc.id, readerB, { cycleAgoDays: 40, dueInDays: 1, escalated: true });
    await movePolicyDeadlines(doc, { due_days: 20, due_at: null }, { actor });
    assert.deepEqual(await assignRow(removed.id), removed, "the removed row is untouched");
    const stale2 = (await assignRow(stale.id))!;
    assertNear(stale2.due_at, new Date(new Date(stale.cycle_started_at).getTime() + 20 * DAY), 5_000, "cycle start 40 days ago + 20: in the past");
    assert.equal(stale2.escalated_at, stale.escalated_at, "an escalation that already fired for a date still past is kept");
  });

  test("due_history keeps the last ten moves, oldest first, newest last", async () => {
    const doc = await newPolicy("history");
    const a = await assign(doc.id, readerA, { cycleAgoDays: 1, dueInDays: 13 });
    for (let i = 1; i <= DUE_HISTORY_MAX + 3; i++) {
      const r = await moveDeadlines(doc.id, { due_days: 20 + i, due_at: null }, { dueDays: 14, actor: { id: readerB, name: "Mover" } });
      assert.equal(r.moved, 1, `move ${i}`);
    }
    const row = (await assignRow(a.id))!;
    assert.equal(row.due_history.length, DUE_HISTORY_MAX);
    const reasons = row.due_history.map((h) => h.reason);
    assert.equal(reasons[0], `Deadline rule changed to ${20 + 4} days after assignment`, "the first three moves fell off");
    assert.equal(reasons[DUE_HISTORY_MAX - 1], `Deadline rule changed to ${20 + DUE_HISTORY_MAX + 3} days after assignment`);
    assert.ok(row.due_history.every((h) => h.by === readerB && h.kind === "moved"));
    for (let i = 1; i < row.due_history.length; i++) {
      assert.equal(row.due_history[i].from, row.due_history[i - 1].to, `entry ${i} starts where the previous ended`);
    }
    assertSameInstant(row.due_history[DUE_HISTORY_MAX - 1].to, row.due_at, "the newest entry ends on the row's date");
  });
});

describe("the re-confirmation cycle restarts the clocks", () => {
  const makeDue = (id: number) =>
    pool().query("UPDATE documents SET ack_recert_months = 12, ack_next_recert_at = now() - interval '1 minute' WHERE id = $1", [id]);

  test("open rows get a fresh due date from the cascade and cleared reminder and escalation stamps; exempt and removed rows are left alone", async () => {
    const doc = await newPolicy("cycle");
    const a = await assign(doc.id, readerA, { cycleAgoDays: 300, dueInDays: -286, reminded: true, escalated: true });
    const exempt = await assign(doc.id, readerB, { cycleAgoDays: 300, dueInDays: -286, reminded: true, exempt: true });
    const removed = await assign(doc.id, readerC, { cycleAgoDays: 300, dueInDays: -286, removed: true });
    await makeDue(doc.id);

    // The workspace layer (21) applies: no policy or space value.
    const cycles = await claimDueRecertifications(null, { documentIds: [doc.id], defaults: { due_days: 21 }, timeZone: "UTC" });
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].rearmed, 1, "one open row restarted");
    const a2 = (await assignRow(a.id))!;
    assertNear(a2.due_at, new Date(Date.now() + 21 * DAY), 60_000, "A: now + the workspace's 21 days");
    assert.equal(a2.reminded_at, null);
    assert.equal(a2.escalated_at, null);
    assert.equal(a2.cycle_started_at, a.cycle_started_at, "the row's cycle start is the audience agent's to move");
    assert.deepEqual(await assignRow(exempt.id), exempt, "the exempt row is untouched");
    assert.deepEqual(await assignRow(removed.id), removed, "the removed row is untouched");

    // The policy's own number wins over the workspace's; a fixed date ahead wins over both.
    await setPolicyRule(doc.id, { due_days: 5 });
    await makeDue(doc.id);
    await claimDueRecertifications(null, { documentIds: [doc.id], defaults: { due_days: 21 }, timeZone: "UTC" });
    assertNear((await assignRow(a.id))!.due_at, new Date(Date.now() + 5 * DAY), 60_000, "A: now + the policy's 5 days");
    const fixed = ymdFromNow(60);
    await setPolicyRule(doc.id, { due_days: 5, due_at: fixed });
    await makeDue(doc.id);
    await claimDueRecertifications(null, { documentIds: [doc.id], defaults: { due_days: 21 }, timeZone: "Europe/Berlin" });
    assert.equal((await assignRow(a.id))!.due_at, endOfDayIn(fixed, "Europe/Berlin")!.toISOString(), "A: the fixed day, ending in Berlin");
    // A fixed date that has passed: the relative rule again.
    await setPolicyRule(doc.id, { due_days: 5, due_at: ymdFromNow(-2) });
    await makeDue(doc.id);
    await claimDueRecertifications(null, { documentIds: [doc.id], defaults: null, timeZone: "UTC" });
    assertNear((await assignRow(a.id))!.due_at, new Date(Date.now() + 5 * DAY), 60_000, "A: now + 5 again");
    // The space layer sits between: no policy number, the space's 9 over the workspace's 21.
    await setPolicyRule(doc.id, {});
    await updateSpace(spaceId, { policy_defaults: { due_days: 9 } });
    await makeDue(doc.id);
    await claimDueRecertifications(null, { documentIds: [doc.id], defaults: { due_days: 21 }, timeZone: "UTC" });
    assertNear((await assignRow(a.id))!.due_at, new Date(Date.now() + 9 * DAY), 60_000, "A: now + the space's 9 days");
    await updateSpace(spaceId, { policy_defaults: {} });
    assert.deepEqual(await assignmentDueDates(doc.id, [readerA, readerB, readerC]), new Map([[readerA, (await assignRow(a.id))!.due_at]]), "only the open row has a due date to tell");
  });

  test("dueAtSql is one expression over the aliases ps and s, usable by any claim or reconcile", async () => {
    const doc = await newPolicy("sql");
    await setPolicyRule(doc.id, { due_days: 3 });
    const r = await pool().query<{ due: string; joiner: string }>(
      `SELECT ${dueAtSql({ from: "'2026-10-20T10:00:00Z'::timestamptz", workspace: "$2", timeZone: "$3" })} AS due,
              ${dueAtSql({ from: "'2026-10-20T10:00:00Z'::timestamptz", workspace: "$2", timeZone: "$3", key: "new_joiner_days" })} AS joiner
         FROM documents d
         LEFT JOIN policy_settings ps ON ps.document_id = d.id
         LEFT JOIN spaces s ON s.id = d.space_id
        WHERE d.id = $1`,
      [doc.id, 21, "UTC"]
    );
    assert.equal(r.rows[0].due, "2026-10-23T10:00:00.000Z", "the policy's 3 days");
    assert.equal(r.rows[0].joiner, "2026-11-10T10:00:00.000Z", "new joiners: no policy number, the workspace's 21");
    await setPolicyRule(doc.id, { due_at: "2026-10-29" });
    const fixed = await pool().query<{ due: string }>(
      `SELECT ${dueAtSql({ from: "'2026-10-20T10:00:00Z'::timestamptz", workspace: "$2", timeZone: "$3" })} AS due
         FROM documents d LEFT JOIN policy_settings ps ON ps.document_id = d.id LEFT JOIN spaces s ON s.id = d.space_id WHERE d.id = $1`,
      [doc.id, null, "America/New_York"]
    );
    assert.equal(fixed.rows[0].due, "2026-10-30T03:59:59.999Z", "the fixed day ends in New York");
    const past = await pool().query<{ due: string }>(
      `SELECT ${dueAtSql({ from: "'2026-11-20T10:00:00Z'::timestamptz", workspace: "$2", timeZone: "$3" })} AS due
         FROM documents d LEFT JOIN policy_settings ps ON ps.document_id = d.id LEFT JOIN spaces s ON s.id = d.space_id WHERE d.id = $1`,
      [doc.id, null, "UTC"]
    );
    assert.equal(past.rows[0].due, "2026-12-04T10:00:00.000Z", "the fixed day has passed: from + the built-in 14");
  });

  test("dueRearmSql drops into any UPDATE of a row (and an ON CONFLICT SET) without joins: the one fragment every clock restart uses", async () => {
    const doc = await newPolicy("rearm");
    await setPolicyRule(doc.id, { due_days: 3 });
    const a = await assign(doc.id, readerA, { dueInDays: null });
    const r = await pool().query<{ due_at: string }>(
      `UPDATE policy_assignments pa SET ${dueRearmSql("pa", { workspace: "$2", timeZone: "$3" })} WHERE pa.id = $1 RETURNING due_at`,
      [a.id, 21, "UTC"]
    );
    assertNear(r.rows[0].due_at, new Date(Date.now() + 3 * DAY), 60_000, "the policy's 3 days from now");
    // The same fragment in an upsert's SET, the row named by the table.
    const up = await pool().query<{ due_at: string }>(
      `INSERT INTO policy_assignments (document_id, user_id, source) VALUES ($1, $4, 'manual')
       ON CONFLICT (document_id, user_id) DO UPDATE
         SET cycle_started_at = now(), ${dueRearmSql("policy_assignments", { workspace: "$2", timeZone: "$3" })}
       RETURNING due_at`,
      [doc.id, 21, "UTC", readerA]
    );
    assertNear(up.rows[0].due_at, new Date(Date.now() + 3 * DAY), 60_000, "re-opened: the policy's 3 days again");
    await setPolicyRule(doc.id, {});
    const inherited = await pool().query<{ due_at: string }>(
      `UPDATE policy_assignments pa SET ${dueRearmSql("pa", { workspace: "$2", timeZone: "$3", from: "clock_timestamp()" })} WHERE pa.id = $1 RETURNING due_at`,
      [a.id, 21, "UTC"]
    );
    assertNear(inherited.rows[0].due_at, new Date(Date.now() + 21 * DAY), 60_000, "no policy number: the workspace's 21");
  });
});

describe("the email tags", () => {
  test("ack_request renders the due line and the subject suffix when there is a date, and neither when there is none", async () => {
    const base = {
      requester_name: "Dana",
      doc_title: `${STAMP} tags`,
      doc_url: `${ORIGIN}/doc/1#confirm-reading`,
      request_type: "requested",
      request_label: "Action required",
      change_note: "",
      reason: "",
    };
    const dated = await renderEmail(
      "ack_request",
      { ...base, due_date: "29 Oct 2026", due_line: "Please confirm by 29 Oct 2026.", due_suffix: " by 29 Oct 2026", days_left: "9" },
      ORIGIN
    );
    assert.match(dated.subject, /confirm "[^"]+" by 29 Oct 2026$/, dated.subject);
    assert.match(dated.text, /Please confirm by 29 Oct 2026\./);
    assert.match(dated.html, /Please confirm by 29 Oct 2026\./);
    const undated = await renderEmail("ack_request", { ...base, due_date: "", due_line: "", due_suffix: "", days_left: "" }, ORIGIN);
    assert.match(undated.subject, /confirm "[^"]+"$/, undated.subject);
    assert.doesNotMatch(undated.text, /Please confirm by/);
    assert.doesNotMatch(undated.text, /\{\{/, "no tag is left showing");
  });

  test("one notice, several dates: each person's mail and inbox line carry their own due date, formatted the workspace's way", async () => {
    const doc = await newPolicy("notice");
    const settings = await getAppSettings();
    const dueA = new Date(Date.now() + 9 * DAY).toISOString();
    const dueB = new Date(Date.now() + 2 * DAY).toISOString();
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer: Mailer = async (to, subject, text) => {
      for (const t of to) sent.push({ to: t, subject, text });
    };
    const r = await notifyAckRequest({
      docId: doc.id,
      docTitle: doc.title,
      mode: "request",
      source: "manual",
      users: [
        { id: readerA, name: "Due Reader A", email: `${STAMP}-Reader A@example.test`, due_at: dueA },
        { id: readerB, name: "Due Reader B", email: `${STAMP}-Reader B@example.test`, due_at: dueB },
        { id: readerC, name: "Due Reader C", email: `${STAMP}-Reader C@example.test`, due_at: null },
      ],
      requesterId: null,
      requesterName: "Due Tester",
      origin: ORIGIN,
      mailer,
    });
    assert.deepEqual(r.errors, []);
    assert.equal(r.emailed, 3);
    assert.equal(r.noticed, 3);
    const byTo = (tag: string) => sent.find((m) => m.to === `${STAMP}-${tag}@example.test`)!;
    const textA = formatDate(dueA, settings);
    const textB = formatDate(dueB, settings);
    assert.ok(byTo("Reader A").subject.endsWith(` by ${textA}`), byTo("Reader A").subject);
    assert.ok(byTo("Reader B").subject.endsWith(` by ${textB}`), byTo("Reader B").subject);
    assert.match(byTo("Reader A").text, new RegExp(`Please confirm by ${textA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
    assert.doesNotMatch(byTo("Reader C").subject, / by /, "no date, no suffix");
    assert.doesNotMatch(byTo("Reader C").text, /Please confirm by/);
    const inbox = async (userId: number) =>
      (await pool().query<{ body: string }>("SELECT body FROM notifications WHERE user_id = $1 AND kind = 'ack_requested' AND title LIKE $2", [userId, `%${doc.title}%`])).rows.map((x) => x.body);
    assert.deepEqual(await inbox(readerA), [`Please read and confirm "${doc.title}" by ${textA}.`]);
    assert.deepEqual(await inbox(readerB), [`Please read and confirm "${doc.title}" by ${textB}.`]);
    assert.deepEqual(await inbox(readerC), [`Please read and confirm "${doc.title}".`]);
  });
});

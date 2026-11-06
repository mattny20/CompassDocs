// Helpdesk 1.19.1 business-hours waits (agent V5, mock-up #12): workflow
// Wait steps, task due offsets and approval reminders may count business
// days or hours in a team's calendar; calendar time stays the default, so
// definitions saved before (and runs pinned to them) are unchanged. Plus the
// 1.19.0 carry-over: a bare re-time "from creation" counts the paused time
// in business minutes, never wall-clock.
//
// The pure date rules first (no database), then the engine through the
// core's own createTicket (its hook starts the run) and the sweep (with
// claim:false and this file's run ids), the test run, and the re-time.
//
// Parallel-safe: every team, calendar, holiday set, request type, workflow
// and account is this file's own (STAMP), and is removed afterwards.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-business-hours-waits.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import {
  checkCount,
  countExample,
  countedHoursLabel,
  countedReminderAt,
  countedTaskDue,
  countedWaitUntil,
  shiftBusinessDays,
} from "../src/lib/helpdesk/business-waits-shared";
import { scheduleFromLegacy } from "../src/lib/helpdesk/calendars-shared";
import type { HdBusinessHours, HdFormField, HdWorkflowStep } from "../src/lib/helpdesk/types";

// --- Licence stub (lib/ee) -------------------------------------------------------

const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-bh-waits.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const orig = loader._resolveFilename;
  loader._resolveFilename = function (r: string, p: { filename?: string } | null, ...rest: unknown[]) {
    if (r === "@/lib/ee") return EE_STUB;
    if ((r === "./ee" || r === "../ee") && p?.filename && path.resolve(path.dirname(p.filename), r) === EE_REAL) return EE_STUB;
    return orig.call(this, r, p, ...rest);
  };
}
/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
/* eslint-enable @typescript-eslint/no-require-imports */

// --- Pure rules ----------------------------------------------------------------------

/** Mon–Fri 09:00–17:30 London, closed Dec 25, Dec 28, Dec 31 2026 and Jan 1 2027. */
const LONDON: HdBusinessHours = {
  timezone: "Europe/London",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:30",
  holidays: [],
  schedule: scheduleFromLegacy([1, 2, 3, 4, 5], "09:00", "17:30"),
  holidayRanges: [
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Boxing Day (substitute)" },
    { date: "2026-12-31", name: "New Year's Eve" },
    { date: "2027-01-01", name: "New Year's Day" },
  ],
};

describe("business days", () => {
  test("2 business days before Mon Jan 4 skips the weekend and both holidays", () => {
    const r = shiftBusinessDays("2027-01-04", -2, LONDON, "open");
    assert.equal(r.date, "2026-12-29");
    assert.equal(new Date(r.at!).toISOString(), "2026-12-29T09:00:00.000Z", "a wait moves on when that day opens");
    assert.deepEqual(r.holidays.map((h) => h.date), ["2026-12-31", "2027-01-01"]);
  });

  test("1 business day before is Wed Dec 30; a due is at the day's close", () => {
    const r = shiftBusinessDays("2027-01-04", -1, LONDON, "close");
    assert.equal(r.date, "2026-12-30");
    assert.equal(new Date(r.at!).toISOString(), "2026-12-30T17:30:00.000Z");
  });

  test("days after count forward; on the day rolls past a holiday", () => {
    assert.equal(shiftBusinessDays("2026-12-30", 1, LONDON, "open").date, "2027-01-04");
    assert.equal(shiftBusinessDays("2026-12-24", 1, LONDON, "open").date, "2026-12-29");
    const onHoliday = shiftBusinessDays("2026-12-25", 0, LONDON, "open");
    assert.equal(onHoliday.date, "2026-12-29");
    assert.deepEqual(onHoliday.holidays.map((h) => h.name), ["Christmas Day", "Boxing Day (substitute)"]);
    assert.equal(shiftBusinessDays("2026-12-30", 0, LONDON, "open").date, "2026-12-30", "a business day stays put");
  });

  test("a part-day holiday leaves the day a business day", () => {
    const half: HdBusinessHours = { ...LONDON, holidayRanges: [{ date: "2026-12-24", name: "Christmas Eve", from: "13:00" }] };
    const r = shiftBusinessDays("2026-12-25", -1, half, "close");
    assert.equal(r.date, "2026-12-24");
    assert.equal(new Date(r.at!).toISOString(), "2026-12-24T13:00:00.000Z", "due when the half day closes");
  });

  test("hours count business hours: Fri 16:00 + 4 business hours is Mon 11:30", () => {
    const from = new Date("2026-11-06T16:00:00Z");
    assert.equal(countedWaitUntil({ after_hours: 4 }, {}, from, "business", LONDON).toISOString(), "2026-11-09T11:30:00.000Z");
    assert.equal(countedWaitUntil({ after_hours: 4 }, {}, from, "calendar", LONDON).toISOString(), "2026-11-06T20:00:00.000Z");
    assert.equal(countedReminderAt(from, 4, "business", LONDON)!.toISOString(), "2026-11-09T11:30:00.000Z");
    assert.equal(countedTaskDue({ after_hours: 4 }, {}, from, "business", LONDON)!.toISOString(), "2026-11-09T11:30:00.000Z");
  });

  test("calendar mode keeps the 1.19.0 times (00:00 UTC waits, 17:00 UTC dues)", () => {
    const answers = { start_date: "2027-01-04" };
    const now = new Date("2026-11-06T10:00:00Z");
    assert.equal(countedWaitUntil({ field: "start_date", offset_days: -2 }, answers, now, "calendar", null).toISOString(), "2027-01-02T00:00:00.000Z");
    assert.equal(countedTaskDue({ field: "start_date", offset_days: -3 }, answers, now, "calendar", null)!.toISOString(), "2027-01-01T17:00:00.000Z");
    assert.equal(workflows.waitUntil({ field: "start_date" }, answers, now).toISOString(), "2027-01-04T00:00:00.000Z");
  });

  test("a calendar with no open hours falls back to calendar time, never year 9999", () => {
    const shut: HdBusinessHours = { ...LONDON, schedule: [[], [], [], [], [], [], []] };
    const from = new Date("2026-11-06T16:00:00Z");
    assert.equal(countedWaitUntil({ after_hours: 4 }, {}, from, "business", shut).toISOString(), "2026-11-06T20:00:00.000Z");
    assert.equal(countedWaitUntil({ field: "d", offset_days: -1 }, { d: "2027-01-04" }, from, "business", shut).toISOString(), "2027-01-03T00:00:00.000Z");
  });

  test("the worked example names the holidays it passes over", () => {
    const ex = countExample(-2, LONDON, { fieldLabel: "Start date", kind: "wait", now: Date.parse("2026-12-28T12:00:00Z") });
    assert.ok(ex);
    assert.equal(ex.text, "Start date Mon Jan 4 → moves on Tue Dec 29 (Dec 31 and Jan 1 are holidays).");
    const plain: HdBusinessHours = { ...LONDON, holidayRanges: [] };
    const ex2 = countExample(-2, plain, { fieldLabel: "Start date", kind: "due", now: Date.parse("2026-11-06T12:00:00Z") });
    assert.ok(ex2);
    assert.match(ex2.text, /^Start date Mon Nov 16 → due Thu Nov 12 \(the weekend doesn't count\)\.$/);
  });

  test("labels say how they count", () => {
    assert.equal(countedHoursLabel(8, "business"), "1 business day");
    assert.equal(countedHoursLabel(8, "calendar"), "8 hours");
    assert.equal(countedHoursLabel(48, "calendar"), "2 days");
    assert.equal(countedHoursLabel(4, "business"), "4 business hours");
  });
});

describe("definitions", () => {
  test("count is additive: calendar steps parse byte-identical, business ones keep their team", () => {
    const old: HdWorkflowStep[] = [
      { key: "a", kind: "approval", title: "Manager approves", approver: { kind: "manager" }, on_decline: "close", remind_after_hours: 8 },
      { key: "t", kind: "task", title: "Laptop", team_id: 1, due: { field: "start_date", offset_days: -3 } },
      { key: "w", kind: "wait", title: "Until the start date", until: { field: "start_date" } },
    ];
    const p1 = workflows.parseWorkflowDefinition({ trigger: {}, steps: old });
    assert.ok(p1.ok);
    assert.deepEqual(p1.value.steps, old);
    const p2 = workflows.parseWorkflowDefinition({
      trigger: {},
      steps: [
        { ...old[0], count: "business", count_team_id: 7 },
        { ...old[1], count: "business" },
        { key: "w", kind: "wait", title: "Until 2 business days before", until: { field: "start_date", offset_days: -2 }, count: "business" },
        { key: "w2", kind: "wait", title: "Calendar", until: { after_hours: 8 }, count: "calendar" },
        { key: "a2", kind: "approval", title: "No reminder", approver: { kind: "manager" }, on_decline: "close", count: "business" },
      ],
    });
    assert.ok(p2.ok, !p2.ok ? p2.error : "");
    assert.deepEqual(p2.value.steps[0], { ...old[0], count: "business", count_team_id: 7 });
    assert.deepEqual(p2.value.steps[1], { ...old[1], count: "business" });
    assert.deepEqual(p2.value.steps[2], { key: "w", kind: "wait", title: "Until 2 business days before", until: { field: "start_date", offset_days: -2 }, count: "business" });
    assert.equal("count" in p2.value.steps[3], false, "a stored calendar is dropped");
    assert.equal("count" in p2.value.steps[4], false, "nothing to count without a reminder");
    assert.equal(checkCount({ count: "weekly" }, "Step 1").ok, false);
    assert.equal(checkCount({ count: "business", count_team_id: -1 }, "Step 1").ok, false);
  });
});

// --- Engine, test run and re-time (database) --------------------------------------------

const STAMP = `hdbh-${Date.now()}-${process.pid}`;
let teamId = 0;
let otherTeam = 0;
let calId = 0;
let setId = 0;
let userId = 0;
const workflowIds: number[] = [];
const typeIds: number[] = [];
const ticketIds: number[] = [];

const FORM: HdFormField[] = [{ key: "start_date", label: "Start date", type: "date", required: true }];

async function publishedType(steps: HdWorkflowStep[]): Promise<number> {
  const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow ${workflowIds.length + 1}` });
  assert.ok(meta.ok);
  const def = workflows.parseWorkflowDefinition({ trigger: {}, steps });
  assert.ok(def.ok, !def.ok ? def.error : "");
  const wf = await workflows.createWorkflow(meta.value, def.value);
  workflowIds.push(wf.id);
  const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Type ${workflowIds.length}`, team_id: teamId, form: FORM, workflow_id: wf.id });
  assert.ok(input.ok, !input.ok ? input.error : "");
  const rt = await requestTypes.createRequestType(input.value);
  typeIds.push(rt.id);
  const pub = await workflows.publishWorkflow(wf.id);
  assert.ok(pub.ok);
  return rt.id;
}

async function raise(typeId: number, startDate: string) {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} new starter`,
      body: "Starting soon.",
      requester: { id: userId, name: "Bea Business", email: `${STAMP}@example.test` },
      request_type_id: typeId,
      answers: { start_date: startDate } as never,
    },
    { silent: true, actorId: userId, actorName: "Bea Business" }
  );
  ticketIds.push(t.id);
  const fresh = (await tickets.getTicketById(t.id))!;
  const children = (await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = $1", [t.id])).rows as { id: number }[];
  ticketIds.push(...children.map((c) => c.id));
  return fresh;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const u = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Bea Business', $2, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-req`,
    `${STAMP}-req@example.test`,
  ]);
  userId = u.rows[0].id;
  teamId = (await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} IT Service Desk`])).rows[0].id;
  otherTeam = (await pool().query("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} People Team`])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'lead')", [teamId, userId]);
  const set = await calendars.createHolidaySet({
    name: `${STAMP} holidays`,
    holidays: LONDON.holidayRanges!.map((h) => ({ date: h.date, name: h.name, recurring_yearly: false, closed_from: null, closed_to: null })),
  });
  setId = set.id;
  const cal = await calendars.createCalendar({ name: `${STAMP} London`, timezone: "Europe/London", schedule: LONDON.schedule!, holiday_set_ids: [setId] });
  calId = cal.id;
  await calendars.assignTeamCalendar(teamId, calId);
});

after(async () => {
  if (ticketIds.length) await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1::int[]) OR parent_ticket_id = ANY($1::int[])", [ticketIds]);
  if (typeIds.length) await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1::int[])", [typeIds]);
  if (workflowIds.length) await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1::int[])", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1::int[])", [[teamId, otherTeam]]);
  if (calId) await calendars.deleteCalendar(calId).catch(() => undefined);
  if (setId) await calendars.deleteHolidaySet(setId).catch(() => undefined);
  if (userId) await pool().query("DELETE FROM users WHERE id = $1", [userId]);
  await pool().end();
});

describe("the engine counts business days in the team's calendar", () => {
  test("a task due 3 business days before and a wait until 2 business days before the start date", async () => {
    const typeId = await publishedType([
      { key: "t", kind: "task", title: "Laptop and accounts", team_id: teamId, due: { field: "start_date", offset_days: -3 }, count: "business" },
      { key: "w", kind: "wait", title: "Until 2 business days before", until: { field: "start_date", offset_days: -2 }, count: "business" },
    ]);
    const req = await raise(typeId, "2027-01-04");
    const child = (await pool().query("SELECT id, resolve_due FROM hd_tickets WHERE parent_ticket_id = $1", [req.id])).rows[0];
    assert.ok(child, "the task ticket was opened");
    // Dec 31 and Jan 1 are holidays, Dec 28 too: Dec 30, Dec 29, then Dec 24 is the third business day back.
    assert.equal(new Date(child.resolve_due).toISOString(), "2026-12-24T17:30:00.000Z");
    await tickets.updateTicket(child.id, { status: "solved" }, { id: userId, name: "Bea Business" }, { silent: true });
    const wait = (await pool().query("SELECT wait_until FROM hd_workflow_steps WHERE run_id = $1 AND step_key = 'w'", [req.workflow_run_id])).rows[0];
    assert.ok(wait, "the wait started once the task was done");
    assert.equal(new Date(wait.wait_until).toISOString(), "2026-12-29T09:00:00.000Z");
  });

  test("calendar steps (and runs pinned to them) keep the 1.19.0 times", async () => {
    const typeId = await publishedType([
      { key: "t", kind: "task", title: "Laptop", team_id: teamId, due: { field: "start_date", offset_days: -3 } },
      { key: "w", kind: "wait", title: "Until the start date", until: { field: "start_date" } },
    ]);
    const req = await raise(typeId, "2027-01-04");
    const child = (await pool().query("SELECT id, resolve_due FROM hd_tickets WHERE parent_ticket_id = $1", [req.id])).rows[0];
    assert.equal(new Date(child.resolve_due).toISOString(), "2027-01-01T17:00:00.000Z");
    await tickets.updateTicket(child.id, { status: "solved" }, { id: userId, name: "Bea Business" }, { silent: true });
    const wait = (await pool().query("SELECT wait_until FROM hd_workflow_steps WHERE run_id = $1 AND step_key = 'w'", [req.workflow_run_id])).rows[0];
    assert.equal(new Date(wait.wait_until).toISOString(), "2027-01-04T00:00:00.000Z");
  });

  test("count_team_id names another team's calendar (the default calendar here)", async () => {
    const typeId = await publishedType([
      { key: "t", kind: "task", title: "Badge", team_id: teamId, due: { field: "start_date", offset_days: -2 }, count: "business", count_team_id: otherTeam },
    ]);
    const req = await raise(typeId, "2027-01-04");
    const child = (await pool().query("SELECT resolve_due FROM hd_tickets WHERE parent_ticket_id = $1", [req.id])).rows[0];
    const hours = await calendars.hoursForTeam(otherTeam);
    const want = countedTaskDue({ field: "start_date", offset_days: -2 }, { start_date: "2027-01-04" }, new Date(), "business", hours);
    assert.equal(new Date(child.resolve_due).toISOString(), want!.toISOString());
  });

  test("a business-hours reminder goes when that many business hours have passed", async () => {
    const typeId = await publishedType([
      { key: "a", kind: "approval", title: "Lead approves", approver: { kind: "team", team_id: teamId }, on_decline: "close", remind_after_hours: 8, count: "business" },
    ]);
    const req = await raise(typeId, "2027-01-04");
    const appr = (await pool().query("SELECT id, created_at FROM hd_approvals WHERE ticket_id = $1", [req.id])).rows[0];
    const step = (await pool().query("SELECT result FROM hd_workflow_steps WHERE run_id = $1 AND step_key = 'a'", [req.workflow_run_id])).rows[0];
    assert.equal(step.result.remind_count, "business");
    assert.equal(step.result.remind_team_id, teamId);
    const due = countedReminderAt(new Date(appr.created_at), 8, "business", await calendars.hoursForTeam(teamId))!;
    assert.ok(due.getTime() >= new Date(appr.created_at).getTime() + 8 * 3_600_000, "never sooner than calendar hours");
    const early = await engine.sweepWorkflows({ now: new Date(due.getTime() - 60_000), claim: false, runIds: [req.workflow_run_id!] });
    assert.equal(early.reminded, 0);
    const onTime = await engine.sweepWorkflows({ now: new Date(due.getTime() + 60_000), claim: false, runIds: [req.workflow_run_id!] });
    assert.equal(onTime.reminded, 1);
    const again = await engine.sweepWorkflows({ now: new Date(due.getTime() + 120_000), claim: false, runIds: [req.workflow_run_id!] });
    assert.equal(again.reminded, 0, "reminded once");
  });

  test("candidates not yet due in business hours never hide a due one (the sweep pages past them)", async () => {
    const typeId = await publishedType([
      { key: "a", kind: "approval", title: "Lead approves", approver: { kind: "team", team_id: teamId }, on_decline: "close", remind_after_hours: 8, count: "business" },
    ]);
    const req = await raise(typeId, "2027-01-04");
    const a0 = (await pool().query("SELECT id, step_id, ticket_id FROM hd_approvals WHERE ticket_id = $1", [req.id])).rows[0];
    // Mon Feb 8 2027 12:00 London. a0 (the lower id) was asked at 03:00 that day: 9 calendar hours,
    // only 3 business hours, so it passes the calendar prefilter but is not due. a1 was asked on
    // Thursday at 09:00: 8 business hours ran out at 17:00 that day.
    const now = new Date("2027-02-08T12:00:00Z");
    await pool().query("UPDATE hd_approvals SET created_at = '2027-02-08T03:00:00Z' WHERE id = $1", [a0.id]);
    const a1 = (
      await pool().query(
        `INSERT INTO hd_approvals (run_id, step_id, ticket_id, approver_kind, approver_team_id, created_at)
         VALUES ($1, $2, $3, 'team', $4, '2027-02-04T09:00:00Z') RETURNING id`,
        [req.workflow_run_id, a0.step_id, a0.ticket_id, teamId]
      )
    ).rows[0];
    const hours = await calendars.hoursForTeam(teamId);
    assert.ok(countedReminderAt(new Date("2027-02-08T03:00:00Z"), 8, "business", hours)!.getTime() > now.getTime(), "a0 is not due yet");
    assert.ok(countedReminderAt(new Date("2027-02-04T09:00:00Z"), 8, "business", hours)!.getTime() <= now.getTime(), "a1 is due");
    engine.setBusinessReminderPageForTests(1);
    try {
      const r = await engine.sweepWorkflows({ now, claim: false, runIds: [req.workflow_run_id!] });
      assert.equal(r.reminded, 1);
    } finally {
      engine.setBusinessReminderPageForTests(null);
    }
    const rows = (await pool().query("SELECT id, reminded_at FROM hd_approvals WHERE id = ANY($1::int[]) ORDER BY id", [[a0.id, a1.id]])).rows;
    assert.equal(rows[0].reminded_at, null, "a0 waits for its business hours");
    assert.ok(rows[1].reminded_at, "a1 behind it was reached");
  });

  test("the test run shows the business-day result and the holidays it skipped", async () => {
    const sim = await workflows.simulateWorkflow(
      {
        trigger: {},
        steps: [
          { key: "w", kind: "wait", title: "Until 2 business days before", until: { field: "start_date", offset_days: -2 }, count: "business", count_team_id: teamId },
          { key: "t", kind: "task", title: "Laptop", team_id: teamId, due: { field: "start_date", offset_days: -1 }, count: "business" },
        ],
      },
      { answers: { start_date: "2027-01-04" }, now: new Date("2026-11-06T10:00:00Z") },
      { id: userId }
    );
    assert.ok(sim.ok, !sim.ok ? sim.error : "");
    const [w, t] = sim.value.steps;
    assert.equal(w.wait_until, "2026-12-29T09:00:00.000Z");
    assert.match(w.count_note ?? "", /IT Service Desk's office hours and holidays; skips Thu Dec 31 \(New Year's Eve\), Fri Jan 1 \(New Year's Day\)/);
    assert.equal(t.due_at, "2026-12-30T17:30:00.000Z");
  });
});

describe("carry-over: a bare re-time counts paused time in business minutes", () => {
  test("from creation: business pause subtracted, not 16 wall hours", async () => {
    await calendars.saveTeamSlaTargets(teamId, [{ priority: "normal", first_reply_minutes: 240, resolve_minutes: 5100, business_hours: 1 }] as never, null);
    const policy = await calendars.slaPolicyForTeam("normal", teamId);
    assert.ok(policy && policy.business_hours, "a business-hours target applies");
    const r = await pool().query(
      `INSERT INTO hd_tickets (subject, team_id, priority, status, created_at, sla_paused_ms, sla_paused_business_ms, resolve_due, first_replied_at)
       VALUES ($1, $2, 'normal', 'open', now() - interval '3 days', 57600000, 1800000, now() + interval '1 day', now()) RETURNING id, created_at`,
      [`${STAMP} paused`, teamId]
    );
    ticketIds.push(r.rows[0].id);
    await calendars.recomputeDuesForTeam(teamId);
    const row = (await pool().query("SELECT resolve_due FROM hd_tickets WHERE id = $1", [r.rows[0].id])).rows[0];
    const hours = await calendars.hoursForTeam(teamId);
    const { addBusinessMinutes, businessMinutesBetween } = await import("../src/lib/helpdesk/sla");
    const created = new Date(r.rows[0].created_at).getTime();
    const now = Date.now();
    const used = Math.max(0, businessMinutesBetween(created, now, hours) - 30);
    const want = addBusinessMinutes(now, policy!.resolve_minutes - used, hours).getTime();
    assert.ok(Math.abs(new Date(row.resolve_due).getTime() - want) < 120_000, `due ${row.resolve_due} ≈ ${new Date(want).toISOString()}`);
    // The 1.19.0 rule (created + 16 wall hours, then business time) lands elsewhere.
    const wallRule = addBusinessMinutes(now, policy!.resolve_minutes - businessMinutesBetween(created + 57_600_000, now, hours), hours).getTime();
    // At some times of day the 16 wall hours after creation hold exactly the
    // 30 business minutes banked, and the two rules agree by coincidence.
    if (businessMinutesBetween(created, created + 57_600_000, hours) !== 30) {
      assert.notEqual(Math.round(wallRule / 60_000), Math.round(want / 60_000), "the business rule differs from the wall-clock one here");
    }
  });

  test("a resume banks the pause in business minutes", async () => {
    const r = await pool().query(
      `INSERT INTO hd_tickets (subject, team_id, priority, status, created_at, sla_paused_at)
       VALUES ($1, $2, 'normal', 'pending', now() - interval '3 days', now() - interval '2 days') RETURNING id, sla_paused_at`,
      [`${STAMP} resume`, teamId]
    );
    ticketIds.push(r.rows[0].id);
    await tickets.updateTicket(r.rows[0].id, { status: "open" }, { id: userId, name: "Bea Business" }, { silent: true });
    const row = (await pool().query("SELECT sla_paused_ms, sla_paused_business_ms, sla_paused_at FROM hd_tickets WHERE id = $1", [r.rows[0].id])).rows[0];
    assert.equal(row.sla_paused_at, null);
    const { businessMinutesBetween } = await import("../src/lib/helpdesk/sla");
    const want = businessMinutesBetween(new Date(r.rows[0].sla_paused_at), Date.now(), await calendars.hoursForTeam(teamId)) * 60_000;
    assert.ok(Math.abs(Number(row.sla_paused_business_ms) - want) < 120_000, `banked ${row.sla_paused_business_ms} ≈ ${want}`);
    assert.ok(Number(row.sla_paused_ms) > Number(row.sla_paused_business_ms), "wall time is longer than business time");
  });
});

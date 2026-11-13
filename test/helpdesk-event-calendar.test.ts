// Helpdesk 1.20.6: the desk's event calendar (lib/helpdesk/desk-calendar and
// its -shared, -ics, -reminders and -feed halves). Events on tickets (the
// routes, who may, the timeline), time zones and clock changes, the setup
// hold on every solve path (the desk's PATCH, Send and set Solved, a macro,
// an automation, bulk edit, the REST API, the Claude connector, a workflow's
// Finish step, solved → closed, retention's auto-close), request types that
// go on the calendar, meeting invites by email (the reader on hostile input
// too), the double-booking warning, the Calendar page's data and layers,
// reminders (once, re-armed, skipped), the private feed (no session, no
// leaks, one answer for every bad address), the API, webhooks and connector
// additions, merge and anonymising, and the upgrade path.
//
// Same harness as test/helpdesk-solve-requirements: next/headers and lib/ee
// stubbed, routes called with real sessions. Parallel-safe on a shared
// database: everything is in this file's own teams (STAMP), its events are
// years in the future (so no running server's reminder sweep ever sees them
// due) and its reminder sweeps are limited to its own tickets.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-event-calendar.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;
let licensed = true;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-event-calendar.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-event-calendar.virtual.js");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => licensed && f === "helpdesk" };
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
const cal = require("../src/lib/helpdesk/desk-calendar") as typeof import("../src/lib/helpdesk/desk-calendar");
const shared = require("../src/lib/helpdesk/desk-calendar-shared") as typeof import("../src/lib/helpdesk/desk-calendar-shared");
const ics = require("../src/lib/helpdesk/desk-calendar-ics") as typeof import("../src/lib/helpdesk/desk-calendar-ics");
const reminders = require("../src/lib/helpdesk/desk-calendar-reminders") as typeof import("../src/lib/helpdesk/desk-calendar-reminders");
const feed = require("../src/lib/helpdesk/desk-calendar-feed") as typeof import("../src/lib/helpdesk/desk-calendar-feed");
const schema = require("../src/lib/helpdesk/desk-calendar-schema") as typeof import("../src/lib/helpdesk/desk-calendar-schema");
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const sr = require("../src/lib/helpdesk/solve-requirements") as typeof import("../src/lib/helpdesk/solve-requirements");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const recurring = require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring");
const mdInline = require("../src/lib/helpdesk/md-inline") as typeof import("../src/lib/helpdesk/md-inline");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const inboundParse = require("../src/lib/helpdesk/inbound-parse") as typeof import("../src/lib/helpdesk/inbound-parse");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const prefsShared = require("../src/lib/helpdesk/notify-prefs-shared") as typeof import("../src/lib/helpdesk/notify-prefs-shared");
const policy = require("../src/lib/notify-policy-shared") as typeof import("../src/lib/notify-policy-shared");
const templates = require("../src/lib/email-templates") as typeof import("../src/lib/email-templates");
const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
const apiShared = require("../src/lib/helpdesk/api-shared") as typeof import("../src/lib/helpdesk/api-shared");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const withTx = (require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core")).withTx;
const eventRoute = require("../src/app/api/helpdesk/tickets/[number]/event/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/event/route");
const setupRoute = require("../src/app/api/helpdesk/tickets/[number]/event/setup/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/event/setup/route");
const calendarRoute = require("../src/app/api/helpdesk/calendar/route") as typeof import("../src/app/api/helpdesk/calendar/route");
const placesRoute = require("../src/app/api/helpdesk/calendar/places/route") as typeof import("../src/app/api/helpdesk/calendar/places/route");
const prefsRoute = require("../src/app/api/helpdesk/calendar/prefs/route") as typeof import("../src/app/api/helpdesk/calendar/prefs/route");
const feedsRoute = require("../src/app/api/helpdesk/calendar/feeds/route") as typeof import("../src/app/api/helpdesk/calendar/feeds/route");
const feedOneRoute = require("../src/app/api/helpdesk/calendar/feeds/[id]/route") as typeof import("../src/app/api/helpdesk/calendar/feeds/[id]/route");
const feedRoute = require("../src/app/api/helpdesk/calendar/feed/[token]/route") as typeof import("../src/app/api/helpdesk/calendar/feed/[token]/route");
const adminRoute = require("../src/app/api/helpdesk/admin/calendar/route") as typeof import("../src/app/api/helpdesk/admin/calendar/route");
const typeRoute = require("../src/app/api/helpdesk/admin/request-types/[id]/route") as typeof import("../src/app/api/helpdesk/admin/request-types/[id]/route");
const checkRoute = require("../src/app/api/helpdesk/tickets/[number]/solve-requirements/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/solve-requirements/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const bulkRoute = require("../src/app/api/helpdesk/tickets/bulk/route") as typeof import("../src/app/api/helpdesk/tickets/bulk/route");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const v1TicketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
const v1RepliesRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/replies/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/replies/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdWorkflowStepB } from "../src/lib/helpdesk/types";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, text, headers: res.headers };
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

const STAMP = `hdev-${Date.now()}-${process.pid}`;
const ALIAS = `${STAMP}-rooms@example.test`;
const P: Record<string, { id: number; session: string; name: string; email: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const typeIds: number[] = [];
const workflowIds: number[] = [];
const ticketIds: number[] = [];
const tokenIds: number[] = [];
const hookIds: number[] = [];
const recurringIds: number[] = [];
const deliveries: { userId: number; event: string; title: string; body: string; email?: string; urgent: boolean }[] = [];

async function person(key: string, deskRole: string | null, timezone = "") {
  const name = `${key} ${STAMP}`;
  const mail = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id`, [`${STAMP}-${key}`, name, mail, timezone]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session, name, email: mail };
}

async function ticket(subject: string, team: string | null = "A", status = "open", extra: { source?: string; assignee?: number | null } = {}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, assignee_id, solved_at) VALUES ($1, $2, 'Req Person', $3, $4, $5, $6, $7, CASE WHEN $5 = 'solved' THEN now() END) RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, P.req.email, team ? T[team] : null, status, extra.source ?? "portal", extra.assignee ?? null]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const lines = async (ticketId: number) =>
  (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string }[];
const iso = (v: unknown) => new Date(v as string).toISOString();
/** The zone timeline lines and reminders about this file's teams are written in: the default business calendar's (whatever this database has). */
let TZ = "UTC";
/** "Mon 3 Mar 2031, 14:00 to 15:30 (London time)" as a timeline line writes a timed event. */
const said = (startIso: string, endIso: string) =>
  `${shared.eventWhen({ starts_at: startIso, ends_at: endIso, all_day: false, start_date: null, end_date: null }, TZ)} (${shared.zoneLabel(TZ)})`;
const clock = (isoTime: string) => shared.timeLabel(isoTime, TZ);
/** As a timeline line (Markdown) carries it: every ":" escaped, so "14:00" is never read as a directive. */
const md = (x: string) => mdInline.mdInline(x);
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowOf = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const statusOf = async (id: number) => (await rowOf(id)).status as string;
const eventOf = async (id: number) => (await pool().query("SELECT *, to_char(start_date, 'YYYY-MM-DD') AS sd, to_char(end_date, 'YYYY-MM-DD') AS ed FROM hd_ticket_events WHERE ticket_id = $1", [id])).rows[0];
const patch = (who: string, n: number, body: Record<string, unknown>) => call(ticketRoute.PATCH, req(`/tickets/${n}`, P[who].session, body, "PATCH"), { number: String(n) });
const send = (who: string, n: number, body: Record<string, unknown>) => call(messagesRoute.POST, req(`/tickets/${n}/messages`, P[who].session, body), { number: String(n) });
const putEvent = (who: string, n: number, body: Record<string, unknown>) => call(eventRoute.PUT, req(`/tickets/${n}/event`, P[who].session, body, "PUT"), { number: String(n) });
const getEvent = (who: string, n: number) => call(eventRoute.GET, req(`/tickets/${n}/event`, P[who].session), { number: String(n) });
const setup = (who: string, n: number, complete: boolean) => call(setupRoute.POST, req(`/tickets/${n}/event/setup`, P[who].session, { complete }), { number: String(n) });
const actor = () => ({ id: P.agent.id, name: P.agent.name });
const NEEDS = "Before you solve, this ticket needs: the event setup marked complete.";
/** A timed event far in the future (no running reminder sweep ever finds it due). `n` spreads them over different days. */
const when = (n: number, hour = 14, minutes = 90) => {
  const start = Date.UTC(2031, 2, 1 + n, hour, 0);
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(start + minutes * 60_000).toISOString() };
};
/** A ticket with an event on it. */
async function eventTicket(subject: string, n: number, extra: Record<string, unknown> = {}, team = "A") {
  const t = await ticket(subject, team);
  const r = await putEvent(team === "A" ? "agent" : "other", t.number, { ...when(n), place: `Room ${n} ${STAMP}`, setup_minutes: 30, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return t;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async () => {});
  hooks.setWebhookAutoSendForTests(false);
  notify.setAgentDeliverySpyForTests((userId, event, p) => deliveries.push({ userId, event, title: p.title, body: p.body, email: p.email?.template, urgent: p.urgent }));
  inbound.resetInboundRateLimitsForTests();
  T.A = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 9420) RETURNING id", [`${STAMP} A`, ALIAS])).rows[0].id;
  T.B = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9420) RETURNING id", [`${STAMP} B`])).rows[0].id;
  TZ = (await calendars.hoursForTeam(T.A)).timezone;
  await person("agent", "agent", "UTC");
  await person("agent2", "agent");
  await person("lead", "team_lead");
  await person("other", "agent");
  await person("admin", "manager");
  await person("dadmin", "admin");
  await person("req", null, "America/New_York");
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'lead'), ($5, $6, 'agent')",
    [T.A, P.agent.id, P.agent2.id, P.lead.id, T.B, P.other.id]
  );
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  email.setHelpdeskTransportForTests(null);
  hooks.setWebhookAutoSendForTests(true);
  notify.setAgentDeliverySpyForTests(null);
  sr.invalidateSolveSets();
  const children = await pool().query("SELECT id FROM hd_tickets WHERE parent_ticket_id = ANY($1) OR team_id = ANY($2) OR requester_email LIKE $3", [ticketIds, Object.values(T), `${STAMP}%`]);
  const all = [...new Set([...ticketIds, ...children.rows.map((r) => r.id as number)])];
  await pool().query("DELETE FROM hd_recurring WHERE id = ANY($1) OR team_id = ANY($2)", [recurringIds, Object.values(T)]);
  await pool().query("DELETE FROM hd_webhooks WHERE id = ANY($1) OR name LIKE $2", [hookIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_calendar_feeds WHERE owner_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_calendar_prefs WHERE user_id = ANY($1)", [userIds]);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL, merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_macros WHERE title LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// =======================================================================================

describe("time (pure)", () => {
  test("a wall clock time in a zone: winter, summer, the hour the clocks skip, the hour they repeat", () => {
    const at = (s: string, tz: string) => new Date(shared.wallToInstant(s, tz)!).toISOString();
    assert.equal(at("2026-01-15T14:00", "Europe/London"), "2026-01-15T14:00:00.000Z");
    assert.equal(at("2026-07-15T14:00", "Europe/London"), "2026-07-15T13:00:00.000Z");
    // 29 March 2026, London: 01:00 to 02:00 does not exist. 01:30 is read as that long after 01:00, which is 02:30 summer time.
    assert.equal(at("2026-03-29T01:30", "Europe/London"), "2026-03-29T01:30:00.000Z");
    assert.equal(shared.instantToWall(shared.wallToInstant("2026-03-29T01:30", "Europe/London")!, "Europe/London"), "2026-03-29T02:30");
    // 25 October 2026, London: 01:30 happens twice. The first one (still summer time), as iCalendar reads it.
    assert.equal(at("2026-10-25T01:30", "Europe/London"), "2026-10-25T00:30:00.000Z");
    assert.equal(at("2026-03-08T02:30", "America/New_York"), "2026-03-08T07:30:00.000Z", "03:30 daylight time");
    assert.equal(at("2026-11-01T01:30", "America/New_York"), "2026-11-01T05:30:00.000Z", "the first 01:30, still daylight time");
    // Lord Howe Island moves by half an hour; Chatham is 45 minutes off the hour; a zone that skips midnight (Santiago, September).
    assert.equal(at("2026-10-04T02:15", "Australia/Lord_Howe"), "2026-10-03T15:45:00.000Z");
    assert.equal(at("2026-06-01T12:00", "Pacific/Chatham"), "2026-05-31T23:15:00.000Z");
    assert.equal(new Date(shared.dayStart("2026-09-06", "America/Santiago")).toISOString(), "2026-09-06T04:00:00.000Z", "midnight is skipped: the day starts at 01:00");
    assert.equal(at("2026-06-01T09:00", "Asia/Kolkata"), "2026-06-01T03:30:00.000Z", "a half-hour zone");
    assert.equal(shared.wallToInstant("2026-02-30T10:00", "UTC"), null);
    assert.equal(shared.wallToInstant("2026-02-10T24:00", "UTC"), null);
    assert.equal(shared.instantToWall("2026-07-15T13:00:00.000Z", "Europe/London"), "2026-07-15T14:00");
  });

  test("whole days are calendar days: 23 and 25 hours long when the clocks change, and never shifted by the viewer's zone", () => {
    const spring = shared.allDayInstants("2026-03-29", "2026-03-29", "Europe/London");
    assert.equal((spring.ends_at - spring.starts_at) / 3_600_000, 23);
    const autumn = shared.allDayInstants("2026-10-25", "2026-10-25", "Europe/London");
    assert.equal((autumn.ends_at - autumn.starts_at) / 3_600_000, 25);
    const three = shared.allDayInstants("2026-11-20", "2026-11-22", "Pacific/Auckland");
    assert.equal(new Date(three.starts_at).toISOString(), "2026-11-19T11:00:00.000Z");
    const e = { starts_at: new Date(three.starts_at).toISOString(), ends_at: new Date(three.ends_at).toISOString(), ready_at: new Date(three.starts_at).toISOString(), all_day: true, start_date: "2026-11-20", end_date: "2026-11-22" };
    // Seen from Los Angeles it is still 20 to 22 November, though its instants start on the 19th there.
    assert.equal(shared.eventWhen(e, "America/Los_Angeles"), "Fri 20 to Sun 22 Nov 2026, all day");
    assert.equal(shared.eventOnDay(e, "2026-11-19", "America/Los_Angeles"), false);
    assert.equal(shared.eventOnDay(e, "2026-11-20", "America/Los_Angeles"), true);
    assert.equal(shared.eventOnDay(e, "2026-11-22", "America/Los_Angeles"), true);
    assert.equal(shared.eventOnDay(e, "2026-11-23", "America/Los_Angeles"), false);
    assert.equal(shared.eventWhen({ ...e, end_date: "2026-11-20" }, "UTC"), "Fri 20 Nov 2026, all day");
  });

  test("words: when, ready by, lead times", () => {
    const e = { starts_at: "2026-11-20T14:00:00.000Z", ends_at: "2026-11-20T15:30:00.000Z", ready_at: "2026-11-20T13:30:00.000Z", all_day: false, start_date: null, end_date: null };
    assert.equal(shared.eventWhen(e, "Europe/London"), "Fri 20 Nov 2026, 14:00 to 15:30");
    assert.equal(shared.eventWhen(e, "America/New_York", true), "Fri 20 Nov 2026, 9:00 AM to 10:30 AM");
    assert.equal(shared.eventWhen({ ...e, starts_at: "2026-11-20T22:00:00.000Z", ends_at: "2026-11-21T01:00:00.000Z" }, "UTC"), "Fri 20 Nov 2026, 22:00 to Sat 21 Nov, 01:00");
    assert.equal(shared.readyByLabel(e, "Europe/London"), "13:30");
    assert.equal(shared.readyByLabel({ starts_at: "2026-11-20T09:00:00.000Z", ready_at: "2026-11-19T09:00:00.000Z" }, "UTC"), "Thu 19 Nov, 09:00");
    assert.deepEqual([0, 30, 60, 90, 1440, 2880, 1500].map(shared.leadLabel), ["no setup time", "30 minutes", "1 hour", "1 hour 30 minutes", "1 day", "2 days", "1 day 1 hour"]);
    assert.equal(shared.zoneLabel("America/New_York"), "New York time");
    assert.equal(shared.placeKey("  Boardroom   A "), "boardroom a");
  });

  test("the views: a day, a Monday-to-Sunday week, a month's whole weeks; stepping; a block's place in a day and its columns", () => {
    assert.deepEqual(shared.viewRange("day", "2026-11-20").days, ["2026-11-20"]);
    const w = shared.viewRange("week", "2026-11-20");
    assert.deepEqual([w.from, w.to, w.days.length], ["2026-11-16", "2026-11-22", 7]);
    const m = shared.viewRange("month", "2026-11-20");
    assert.deepEqual([m.from, m.to, m.days.length], ["2026-10-26", "2026-12-06", 42]);
    assert.equal(shared.stepDay("month", "2026-01-31", 1), "2026-02-01");
    assert.equal(shared.stepDay("week", "2026-12-30", 1), "2027-01-06");
    assert.equal(shared.viewTitle("week", "2026-11-20"), "16 to 22 Nov 2026");
    assert.equal(shared.viewTitle("week", "2026-12-31"), "28 Dec 2026 to 3 Jan 2027");
    assert.equal(shared.viewTitle("month", "2026-11-20"), "November 2026");
    // 22:00 to 01:00 London: two segments.
    const s = Date.parse("2026-11-20T22:00:00Z");
    const e = Date.parse("2026-11-21T01:00:00Z");
    assert.deepEqual(shared.daySegment(s, e, "2026-11-20", "Europe/London"), { top: 1320, bottom: 1440, before: false, after: true });
    assert.deepEqual(shared.daySegment(s, e, "2026-11-21", "Europe/London"), { top: 0, bottom: 60, before: true, after: false });
    assert.equal(shared.daySegment(s, e, "2026-11-22", "Europe/London"), null);
    const cols = shared.layoutColumns([{ top: 60, bottom: 180, k: "a" }, { top: 120, bottom: 240, k: "b" }, { top: 300, bottom: 360, k: "c" }]);
    assert.deepEqual(cols.map((c) => [c.k, c.col, c.cols]), [["a", 0, 2], ["b", 1, 2], ["c", 0, 1]]);
  });

  test("checking an event: instants with their zone, whole days, lengths, a moved start keeps the length", () => {
    const c = shared.checkEventInput;
    assert.equal(c(null, null, "UTC").ok, false);
    assert.equal(c({ starts_at: "2026-11-20T14:00" }, null, "UTC").ok, false, "an instant must say its zone");
    assert.equal(c({ starts_at: "2026-11-20T14:00:00Z", ends_at: "2026-11-20T13:00:00Z" }, null, "UTC").ok, false);
    assert.equal(c({ starts_at: "2026-11-20T14:00:00Z", ends_at: "2027-01-20T13:00:00Z" }, null, "UTC").ok, false, "over 31 days");
    assert.equal(c({ starts_at: "2026-11-20T14:00:00Z", setup_minutes: -5 }, null, "UTC").ok, false);
    assert.equal(c({ starts_at: "2026-11-20T14:00:00Z", setup_minutes: 20000 }, null, "UTC").ok, false);
    assert.equal(c({ starts_at: "2026-11-20T14:00:00Z", place: "x".repeat(201) }, null, "UTC").ok, false);
    assert.equal(c({ all_day: true, start_date: "2026-02-30" }, null, "UTC").ok, false);
    assert.equal(c({ all_day: true, start_date: "2026-11-22", end_date: "2026-11-20" }, null, "UTC").ok, false);
    assert.equal(c({ starts_at: "2026-11-20T14:00:00Z", timezone: "Mars/Olympus" }, null, "UTC").ok, false);
    const a = c({ starts_at: "2026-11-20T15:00:00+01:00", place: "  Room   1 " }, null, "Europe/Paris");
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.deepEqual([a.value.starts_at.toISOString(), a.value.ends_at.toISOString(), a.value.place, a.value.timezone], ["2026-11-20T14:00:00.000Z", "2026-11-20T15:00:00.000Z", "Room 1", "Europe/Paris"]);
    const moved = c({ starts_at: "2026-11-21T09:00:00Z" }, { ...a.value, ends_at: new Date("2026-11-20T16:30:00Z") }, "UTC");
    assert.ok(moved.ok && moved.value.ends_at.toISOString() === "2026-11-21T11:30:00.000Z" && moved.value.place === "Room 1");
    const day = c({ all_day: true, start_date: "2026-03-29", timezone: "Europe/London" }, a.value, "UTC");
    assert.ok(day.ok);
    if (day.ok) assert.deepEqual([day.value.starts_at.toISOString(), day.value.ends_at.toISOString(), day.value.end_date], ["2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z", "2026-03-29"]);
  });
});

const BS = String.fromCharCode(92);
const CRLF = "\r\n";

describe("the invite reader (pure)", () => {
  const invite = (lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
  const vevent = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

  test("a request with a named zone, a folded line, escapes, an alarm and a second event (only the first is read)", () => {
    const text = invite([
      "METHOD:REQUEST",
      ...vevent([
        "UID:abc-123@example.test",
        "SEQUENCE:2",
        "DTSTART;TZID=Europe/London:20260715T140000",
        "DTEND;TZID=Europe/London:20260715T153000",
        "SUMMARY:Board meeting\\, Q3 and a very long title that an email client has decided to fold right in the mid",
        " dle of a word",
        "LOCATION:Boardroom A\; 2nd floor",
        "BEGIN:VALARM",
        "TRIGGER:-PT15M",
        "SUMMARY:An alarm's own summary",
        "DURATION:PT5M",
        "END:VALARM",
      ]),
      ...vevent(["UID:second", "DTSTART:20270101T000000Z", "SUMMARY:Second"]),
    ]);
    const p = ics.parseInvite(text, "UTC")!;
    assert.deepEqual(
      [p.method, p.uid, p.sequence, p.summary, p.location, p.all_day, new Date(p.starts_at).toISOString(), new Date(p.ends_at).toISOString(), p.timezone, p.repeats, p.notes.length],
      ["request", "abc-123@example.test", 2, "Board meeting, Q3 and a very long title that an email client has decided to fold right in the middle of a word", "Boardroom A; 2nd floor", false, "2026-07-15T13:00:00.000Z", "2026-07-15T14:30:00.000Z", "Europe/London", false, 0]
    );
  });

  test("UTC, an Outlook (Windows) zone, a floating time, an unknown zone, a duration, a repeat rule, lone-LF line ends", () => {
    const utc = ics.parseInvite(invite(vevent(["UID:u", "DTSTART:20261120T140000Z", "DURATION:PT45M"])), "Europe/Paris")!;
    assert.deepEqual([new Date(utc.starts_at).toISOString(), (utc.ends_at - utc.starts_at) / 60_000, utc.method], ["2026-11-20T14:00:00.000Z", 45, "request"]);
    const win = ics.parseInvite(invite(vevent(['UID:w', 'DTSTART;TZID="Pacific Standard Time":20260715T090000', "RRULE:FREQ=WEEKLY;BYDAY=WE"])), "UTC")!;
    assert.deepEqual([new Date(win.starts_at).toISOString(), win.timezone, win.repeats, (win.ends_at - win.starts_at) / 60_000], ["2026-07-15T16:00:00.000Z", "America/Los_Angeles", true, 60]);
    const floating = ics.parseInvite(invite(vevent(["UID:f", "DTSTART:20260715T090000"])).replace(/\r\n/g, "\n"), "Asia/Tokyo")!;
    assert.equal(new Date(floating.starts_at).toISOString(), "2026-07-15T00:00:00.000Z");
    assert.match(floating.notes[0], /without a time zone/);
    const odd = ics.parseInvite(invite(vevent(["UID:o", "DTSTART;TZID=Custom Corp Zone:20260715T090000"])), "Europe/Berlin")!;
    assert.equal(new Date(odd.starts_at).toISOString(), "2026-07-15T07:00:00.000Z");
    assert.match(odd.notes[0], /"Custom Corp Zone"\) isn't one the desk knows/);
    // The note is a Markdown line on the ticket: a zone name written to look like a link or a directive stays plain characters.
    const sly = ics.parseInvite(invite(vevent(["UID:s", 'DTSTART;TZID="[x](http://evil.test) *b* <i>":20260715T090000'])), "UTC")!;
    assert.ok(sly.notes[0].includes(mdInline.mdInline("[x](http://evil.test) *b* <i>")), sly.notes[0]);
    assert.ok(!sly.notes[0].includes("[x](http"), sly.notes[0]);
    assert.equal(ics.zoneFromTzid("/mozilla.org/20050126_1/America/New_York"), "America/New_York");
    assert.equal(ics.zoneFromTzid("GMT Standard Time"), "Europe/London");
    assert.equal(ics.zoneFromTzid("Nowhere"), null);
  });

  test("whole days: DTEND is the day after the last; one day; a month-long one is cut with a note", () => {
    const d = ics.parseInvite(invite(vevent(["UID:d", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261123", "SUMMARY:Offsite"])), "Europe/London")!;
    assert.deepEqual([d.all_day, d.start_date, d.end_date, new Date(d.starts_at).toISOString()], [true, "2026-11-20", "2026-11-22", "2026-11-20T00:00:00.000Z"]);
    const one = ics.parseInvite(invite(vevent(["UID:1", "DTSTART;VALUE=DATE:20261120"])), "UTC")!;
    assert.deepEqual([one.start_date, one.end_date], ["2026-11-20", "2026-11-20"]);
    const long = ics.parseInvite(invite(vevent(["UID:l", "DTSTART;VALUE=DATE:20260101", "DTEND;VALUE=DATE:20260601"])), "UTC")!;
    assert.equal(long.end_date, "2026-01-31");
    assert.match(long.notes[0], /longer than 31 days/);
  });

  test("a cancellation; an attendee's reply and anything else is not an invite; nothing usable is null", () => {
    assert.equal(ics.parseInvite(invite(["METHOD:CANCEL", ...vevent(["UID:c", "SEQUENCE:3", "DTSTART:20261120T140000Z"])]), "UTC")!.method, "cancel");
    assert.equal(ics.parseInvite(invite(["METHOD:REQUEST", ...vevent(["UID:c", "STATUS:CANCELLED", "DTSTART:20261120T140000Z"])]), "UTC")!.method, "cancel");
    assert.equal(ics.parseInvite(invite(["METHOD:REPLY", ...vevent(["UID:c", "DTSTART:20261120T140000Z"])]), "UTC"), null);
    assert.equal(ics.parseInvite(invite(["METHOD:COUNTER", ...vevent(["UID:c", "DTSTART:20261120T140000Z"])]), "UTC"), null);
    assert.equal(ics.parseInvite(invite(vevent(["UID:c", "SUMMARY:No start"])), "UTC"), null);
    assert.equal(ics.parseInvite(invite(vevent(["UID:c", "DTSTART:20261340T990000Z"])), "UTC"), null, "not a date");
    assert.equal(ics.parseInvite(invite(["BEGIN:VTODO", "DTSTART:20261120T140000Z", "END:VTODO"]), "UTC"), null);
    assert.equal(ics.parseInvite(vevent(["UID:c", "DTSTART:20261120T140000Z"]).join("\r\n"), "UTC"), null, "no VCALENDAR around it");
    assert.equal(ics.parseInvite("", "UTC"), null);
    assert.equal(ics.parseInvite("hello\u0000\u0001 world", "UTC"), null);
    // An event nested inside something else is not the calendar's event.
    assert.equal(ics.parseInvite(invite(["BEGIN:VTIMEZONE", ...vevent(["UID:n", "DTSTART:20261120T140000Z"]), "END:VTIMEZONE"]), "UTC"), null);
  });

  test("hostile input is refused or read in bounded time: too large, too many lines, one enormous line, deep nesting, a flood of parameters", () => {
    const timed = <R>(what: string, fn: () => R): R => {
      const t = process.hrtime.bigint();
      const r = fn();
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(ms < 1500, `${what} took ${ms.toFixed(0)}ms`);
      return r;
    };
    const ok = vevent(["UID:x", "DTSTART:20261120T140000Z"]);
    assert.equal(timed("over the size limit", () => ics.parseInvite("BEGIN:VCALENDAR\r\n" + "X".repeat(ics.ICS_LIMITS.bytes + 1), "UTC")), null);
    assert.equal(timed("a large buffer", () => ics.parseInvite(Buffer.alloc(5 * 1024 * 1024, 65), "UTC")), null);
    assert.equal(timed("too many lines", () => ics.parseInvite(invite([...Array.from({ length: ics.ICS_LIMITS.lines + 5 }, () => "X:1"), ...ok]), "UTC")), null);
    // One 200 KB line before the event: cut, and the event after it is still read.
    const longLine = timed("one long line", () => ics.parseInvite(invite(["X-JUNK:" + "A;B:C\"".repeat(30_000), ...ok]), "UTC"));
    assert.equal(longLine?.uid, "x");
    // A line that is all quotes, colons and semicolons (the parameter reader walks it once).
    assert.equal(timed("parameter flood", () => ics.parseInvite(invite([...vevent(["UID:p", `DTSTART${';A="'.repeat(1000)}:20261120T140000Z`])]), "UTC"))?.uid, "p");
    assert.equal(timed("parameter flood, unclosed", () => ics.parseInvite(invite([...vevent(["UID:q", `DTSTART${';A="'.repeat(1001)}:20261120T140000Z`])]), "UTC")), null, "an unclosed quote swallows the value: no start, no invite");
    // 4,000 unclosed components, then an event: nothing nested that deep is the calendar's event.
    assert.equal(timed("deep nesting", () => ics.parseInvite(invite([...Array.from({ length: 4000 }, () => "BEGIN:VEVENT"), "DTSTART:20261120T140000Z"]), "UTC")), null, "the first VEVENT has no start of its own; the ones nested in it are not read");
    // A fold flood: 4,900 continuation lines for one property.
    const folded = timed("fold flood", () => ics.parseInvite(invite(vevent(["UID:f", "DTSTART:20261120T140000Z", "SUMMARY:a", ...Array.from({ length: 4900 }, () => " b")])), "UTC"));
    assert.ok(folded && folded.summary.length <= ics.ICS_LIMITS.summary);
    // Random bytes never throw.
    for (let i = 0; i < 200; i++) {
      const junk = Buffer.from(Array.from({ length: 400 }, () => Math.floor(Math.random() * 256)));
      assert.doesNotThrow(() => ics.parseInvite(Buffer.concat([Buffer.from("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART"), junk]), "UTC"));
    }
    // Control characters and markup in the text never survive into a title or a place.
    const dirty = ics.parseInvite(invite(vevent(["UID:d", "DTSTART:20261120T140000Z", "SUMMARY:Hi\u0007\u001b[31m <script>x</script>", "LOCATION:" + "R".repeat(5000)])), "UTC")!;
    assert.ok(!/[\u0000-\u001f]/.test(dirty.summary));
    assert.equal(dirty.location.length, ics.ICS_LIMITS.location);
  });

  test("the feed writer: escapes, 75-octet folding without splitting a character, whole days end the day after, cancelled", () => {
    const text = ics.buildCalendar("IT, events; all", [
      { uid: "ticket-1@x", summary: "#1 Réunion du comité, salle « Ångström »; préparation " + "é".repeat(60), location: "Room; 1, east", description: "Line one\nLine two", url: "https://x.example/desk/tickets/1", all_day: false, starts_at: new Date("2026-11-20T14:00:00Z"), ends_at: new Date("2026-11-20T15:00:00Z"), start_date: null, end_date: null, cancelled: false, sequence: 3, updated_at: new Date("2026-11-01T00:00:00Z") },
      { uid: "ticket-2@x", summary: "#2 Offsite", location: "", description: "", url: "", all_day: true, starts_at: new Date(), ends_at: new Date(), start_date: "2026-11-20", end_date: "2026-11-22", cancelled: true, sequence: 1, updated_at: new Date("2026-11-01T00:00:00Z") },
    ], new Date("2026-11-13T10:00:00Z"));
    assert.ok(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") && text.endsWith("END:VCALENDAR\r\n"));
    for (const l of text.split("\r\n")) assert.ok(Buffer.byteLength(l, "utf8") <= 75, `a line of ${Buffer.byteLength(l, "utf8")} octets`);
    assert.ok(!text.includes("�"));
    const unfolded = text.replace(/\r\n /g, "");
    assert.ok(unfolded.includes("X-WR-CALNAME:IT" + BS + ", events" + BS + "; all"));
    assert.match(unfolded, /DTSTART:20261120T140000Z\r\nDTEND:20261120T150000Z/);
    assert.ok(unfolded.includes("LOCATION:Room" + BS + "; 1" + BS + ", east"));
    assert.ok(unfolded.includes("DESCRIPTION:Line one" + BS + "nLine two"));
    assert.match(unfolded, /DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261123/);
    assert.match(unfolded, /STATUS:CANCELLED/);
    assert.ok(unfolded.includes("é".repeat(60)), "the folded summary reads back whole");
    // What it writes, the reader reads back.
    const back = ics.parseInvite(text, "UTC")!;
    assert.deepEqual([back.uid, new Date(back.starts_at).toISOString(), back.location], ["ticket-1@x", "2026-11-20T14:00:00.000Z", "Room; 1, east"]);
  });
});

// =======================================================================================

describe("events on tickets", () => {
  test("an agent who works the ticket adds, changes and removes its event; each change leaves an agents-only timeline line", async () => {
    const t = await ticket("Board meeting");
    const none = await getEvent("agent", t.number);
    assert.equal(none.status, 200);
    assert.deepEqual([none.body.event, none.body.can_edit, none.body.default_setup_minutes], [null, true, 30]);

    const bad = await putEvent("agent", t.number, { starts_at: "2031-03-01 14:00" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /date and time with its zone/);
    const made = await putEvent("agent", t.number, { starts_at: "2031-03-03T14:00:00Z", ends_at: "2031-03-03T15:30:00Z", place: "  Boardroom   A ", setup_minutes: 30 });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const e = made.body.event;
    assert.deepEqual([e.starts_at, e.ends_at, e.all_day, e.place, e.setup_minutes, e.ready_at, e.setup_complete, e.cancelled, e.source], ["2031-03-03T14:00:00.000Z", "2031-03-03T15:30:00.000Z", false, "Boardroom A", 30, "2031-03-03T13:30:00.000Z", false, false, "agent"]);
    let row = await eventOf(t.id);
    assert.deepEqual([row.place_key, row.time_rev, row.created_by], ["boardroom a", 1, P.agent.id]);
    let ls = await lines(t.id);
    assert.equal(ls.length, 1);
    assert.equal(ls[0].kind, "internal", "requesters never see it");
    assert.equal(ls[0].body, `${P.agent.name} added an event: ${md(said("2031-03-03T14:00:00Z", "2031-03-03T15:30:00Z"))} at Boardroom A. Setup ready by ${md(clock("2031-03-03T13:30:00Z"))} (30 minutes before).`);

    // A change of place only: the reminders are not re-armed; a moved start keeps the length and re-arms them.
    assert.equal((await putEvent("agent2", t.number, { place: "Boardroom B" })).status, 200);
    row = await eventOf(t.id);
    assert.deepEqual([row.place, row.time_rev, iso(row.starts_at)], ["Boardroom B", 1, "2031-03-03T14:00:00.000Z"]);
    const moved = await putEvent("agent2", t.number, { starts_at: "2031-03-04T09:00:00Z" });
    assert.deepEqual([moved.body.event.ends_at, moved.body.event.ready_at], ["2031-03-04T10:30:00.000Z", "2031-03-04T08:30:00.000Z"]);
    assert.equal((await eventOf(t.id)).time_rev, 2);
    // Saving the same thing again changes nothing and writes no line.
    const n = (await lines(t.id)).length;
    assert.equal((await putEvent("agent2", t.number, { starts_at: "2031-03-04T09:00:00Z", place: "Boardroom B" })).status, 200);
    assert.equal((await lines(t.id)).length, n);

    // A whole-day event, counted in the zone the agent names.
    const day = await putEvent("agent", t.number, { all_day: true, start_date: "2031-03-30", end_date: "2031-03-31", timezone: "Europe/London", setup_minutes: 0 });
    assert.deepEqual([day.body.event.all_day, day.body.event.start_date, day.body.event.end_date, day.body.event.starts_at, day.body.event.ends_at], [true, "2031-03-30", "2031-03-31", "2031-03-30T00:00:00.000Z", "2031-03-31T23:00:00.000Z"]);
    assert.match((await lines(t.id)).at(-1)!.body, /changed the event: Sun 30 to Mon 31 Mar 2031, all day at Boardroom B\.$/);

    const del = await call(eventRoute.DELETE, req(`/tickets/${t.number}/event`, P.agent.session, undefined, "DELETE"), { number: String(t.number) });
    assert.deepEqual([del.status, del.body.removed], [200, true]);
    assert.equal(await eventOf(t.id), undefined);
    ls = await lines(t.id);
    assert.match(ls.at(-1)!.body, /removed the event \(Sun 30 to Mon 31 Mar 2031, all day\)$/);
    assert.ok(ls.every((l) => l.kind === "internal"));
    // The requester's view of the request has none of it.
    const asReq = await call(requestRoute.GET, new Request(`http://localhost/api/helpdesk/requests/${t.number}`, { headers: { cookie: `compass_session=${P.req.session}` } }), { number: String(t.number) });
    assert.equal(asReq.status, 200);
    assert.ok(!/event|Boardroom/i.test(JSON.stringify(asReq.body.messages)), "no event line reaches the requester");
  });

  test("who may: not an agent of another team (404, as if it did not exist), not the requester; a closed or merged ticket's event is fixed", async () => {
    const t = await ticket("Private");
    assert.equal((await putEvent("other", t.number, when(1))).status, 404);
    assert.equal((await getEvent("other", t.number)).status, 404);
    assert.equal((await setup("other", t.number, true)).status, 404);
    assert.equal((await putEvent("req", t.number, when(1))).status, 403);
    assert.equal((await call(eventRoute.PUT, new Request(`http://localhost/api/helpdesk/tickets/${t.number}/event`, { method: "PUT", body: "{}" }), { number: String(t.number) })).status, 401);
    assert.equal(await eventOf(t.id), undefined);
    assert.equal((await setup("agent", t.number, true)).status, 404, "no event to mark");
    // The lead of the team and a manager of every team may.
    assert.equal((await putEvent("lead", t.number, when(1))).status, 200);
    assert.equal((await putEvent("admin", t.number, { place: "Hall" })).status, 200);
    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [t.id]);
    const closed = await putEvent("agent", t.number, { place: "Elsewhere" });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, "A closed ticket's event can't be changed.");
    assert.equal((await getEvent("agent", t.number)).body.can_edit, false);
  });

  test("the ticket detail carries the event; places used before are suggested, only from tickets the agent may see", async () => {
    const t = await eventTicket("Detail", 2, { place: `Atrium ${STAMP}` });
    await eventTicket("Elsewhere", 3, { place: `Vault ${STAMP}` }, "B");
    const d = await call(ticketRoute.GET, req(`/tickets/${t.number}`, P.agent.session), { number: String(t.number) });
    assert.equal(d.body.event.place, `Atrium ${STAMP}`);
    assert.equal(d.body.before_solve, true, "the desk asks before a solve while setup is open");
    const plain = await ticket("No event");
    const d2 = await call(ticketRoute.GET, req(`/tickets/${plain.number}`, P.agent.session), { number: String(plain.number) });
    assert.equal(d2.body.event, undefined);
    assert.equal(d2.body.before_solve, undefined);
    const mine = await call(placesRoute.GET, req(`/calendar/places?q=${encodeURIComponent(STAMP.toUpperCase())}`, P.agent.session));
    assert.ok(mine.body.places.includes(`Atrium ${STAMP}`));
    assert.ok(!mine.body.places.includes(`Vault ${STAMP}`), "another team's place is not suggested");
    const all = await call(placesRoute.GET, req(`/calendar/places?q=${STAMP}`, P.admin.session));
    assert.ok(all.body.places.includes(`Vault ${STAMP}`));
  });
});

describe("double-booking", () => {
  test("the same place (trimmed, any case) at an overlapping time warns on both tickets, setup time included; never a refusal", async () => {
    const a = await ticket("Morning");
    const b = await ticket("Overlap");
    const c = await ticket("Other team", "B");
    const place = `Suite 9 ${STAMP}`;
    assert.equal((await putEvent("agent", a.number, { starts_at: "2031-04-01T10:00:00Z", ends_at: "2031-04-01T11:00:00Z", place, setup_minutes: 0 })).status, 200);
    // 11:00 to 12:00 with 30 minutes of setup: the setup overlaps the first event.
    const second = await putEvent("agent", b.number, { starts_at: "2031-04-01T11:00:00Z", ends_at: "2031-04-01T12:00:00Z", place: `  suite 9   ${STAMP.toUpperCase()} `, setup_minutes: 30 });
    assert.equal(second.status, 200, "an overlap is a warning, never a refusal");
    assert.deepEqual(second.body.conflicts.map((x: { number: number; subject: string }) => [x.number, x.subject]), [[a.number, `Morning ${STAMP}`]]);
    assert.deepEqual((await getEvent("agent", a.number)).body.conflicts.map((x: { number: number }) => x.number), [b.number]);
    // Another team's event at the same place: the agent is told there is one, not which ticket.
    assert.equal((await putEvent("other", c.number, { starts_at: "2031-04-01T10:30:00Z", ends_at: "2031-04-01T10:45:00Z", place, setup_minutes: 0 })).status, 200);
    const seen = (await getEvent("agent", a.number)).body.conflicts;
    assert.equal(seen.length, 2);
    const hidden = seen.find((x: { number: number | null }) => x.number === null);
    assert.deepEqual([hidden.subject, hidden.team_name], [null, `${STAMP} B`]);
    assert.equal((await getEvent("admin", a.number)).body.conflicts.filter((x: { number: number | null }) => x.number === null).length, 0, "someone who sees every team sees both");
    // Back to back with no setup time is not an overlap; a different place is not; a cancelled event is not.
    assert.equal((await putEvent("agent", b.number, { setup_minutes: 0 })).body.conflicts.length, 0);
    assert.equal((await putEvent("agent", b.number, { setup_minutes: 30, place: "Somewhere else" })).body.conflicts.length, 0);
    await putEvent("agent", b.number, { place });
    await cal.cancelTicketEvent(a.id, { id: null, name: "Helpdesk" }, "Cancelled for the test.");
    assert.equal((await getEvent("agent", b.number)).body.conflicts.filter((x: { number: number | null }) => x.number === a.number).length, 0);
  });
});

// =======================================================================================

describe("not closed until setup is complete", () => {
  test("upgrade: a ticket with no event solves exactly as before, and the check costs one read", async () => {
    const t = await ticket("Plain");
    assert.equal(await sr.solveRequirementRefusal(t.id), null);
    assert.equal(await cal.eventSetupOpen(t.id), false);
    const r = await patch("agent", t.number, { status: "solved" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const check = await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.agent.session), { number: String(t.number) });
    assert.deepEqual([check.body.applies, check.body.missing, check.body.event_setup], [false, [], undefined]);
  });

  test("the desk: Solve is refused with one plain sentence and nothing changes; the dialog's tick solves it and records who", async () => {
    const t = await eventTicket("Desk solve", 5);
    const refused = await patch("agent", t.number, { status: "solved" });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual([refused.body.error, refused.body.code, refused.body.missing], [NEEDS, "solve_requirements", [{ kind: "event_setup", key: "setup_complete", label: "The event setup marked complete" }]]);
    assert.equal(await statusOf(t.id), "open");
    assert.equal((await patch("agent", t.number, { status: "closed" })).status, 409, "closing it is refused the same way");
    assert.equal((await patch("agent", t.number, { status: "pending" })).status, 200, "other statuses are free");
    // What the "Before you solve" dialog reads, and its check with the box ticked.
    const check = await call(checkRoute.GET, req(`/tickets/${t.number}/solve-requirements`, P.agent.session), { number: String(t.number) });
    assert.deepEqual([check.body.applies, check.body.error, check.body.missing[0].kind, check.body.event_setup.place], [true, NEEDS, "event_setup", `Room 5 ${STAMP}`]);
    const ticked = await call(checkRoute.POST, req(`/tickets/${t.number}/solve-requirements`, P.agent.session, { solve_fields: { setup_complete: true } }), { number: String(t.number) });
    assert.deepEqual([ticked.status, ticked.body.missing], [200, []]);
    assert.equal((await eventOf(t.id)).setup_done_at, null, "the check stores nothing");
    // The solve carries the tick: one transaction.
    const ok = await patch("agent", t.number, { status: "solved", setup_complete: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const e = await eventOf(t.id);
    assert.ok(e.setup_done_at);
    assert.deepEqual([e.setup_done_by, e.setup_done_by_name], [P.agent.id, P.agent.name]);
    const ls = await lines(t.id);
    assert.ok(ls.some((l) => l.kind === "internal" && /marked the event setup complete$/.test(l.body)));
    assert.ok(ls.some((l) => l.kind === "system" && / to Solved$/.test(l.body)));
  });

  test("the tick is kept only if the ticket is solved: refused for another reason, it is not marked", async () => {
    const t = await eventTicket("Atomic", 6);
    await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = $1", [t.id]);
    const set = await sr.createSolveSet({ name: `${STAMP} set`, enabled: true, team_ids: [T.A], ticket_fields: ["assignee"], fields: [] }, { id: P.admin.id });
    try {
      const r = await patch("agent", t.number, { status: "solved", setup_complete: true });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "Before you solve, this ticket needs: an owner.");
      assert.equal((await eventOf(t.id)).setup_done_at, null, "rolled back with the refused solve");
      const both = await patch("agent", t.number, { status: "solved" });
      assert.equal(both.body.error, "Before you solve, this ticket needs: an owner and the event setup marked complete.", "one sentence names both");
      assert.deepEqual(both.body.missing.map((m: { kind: string }) => m.kind), ["ticket_field", "event_setup"]);
      assert.equal((await patch("agent", t.number, { status: "solved", assignee_id: P.agent.id, setup_complete: true })).status, 200);
    } finally {
      await sr.deleteSolveSet(set.id);
    }
  });

  test("Setup complete from the Event block: who and when; it can be taken back while the ticket is open; then the ticket solves", async () => {
    const t = await eventTicket("Block", 7);
    const done = await setup("agent2", t.number, true);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.event.setup_complete, done.body.event.setup_completed_by], [true, P.agent2.name]);
    assert.ok(done.body.event.setup_completed_at);
    const n = (await lines(t.id)).length;
    assert.equal((await setup("agent", t.number, true)).status, 200, "marking it again changes nothing");
    assert.equal((await lines(t.id)).length, n);
    assert.equal((await eventOf(t.id)).setup_done_by, P.agent2.id, "the first mark stands");
    const undone = await setup("agent", t.number, false);
    assert.equal(undone.body.event.setup_complete, false);
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 409);
    await setup("agent", t.number, true);
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 200);
    const back = await setup("agent", t.number, false);
    assert.equal(back.status, 409);
    assert.equal(back.body.error, "Reopen the ticket before you take back Setup complete.");
    assert.equal((await setup("agent", t.number, "yes" as never)).status, 400);
  });

  test("Send and set Solved: refused before anything is posted; with the tick the reply goes and the ticket solves", async () => {
    const t = await eventTicket("Send", 8);
    const before = (await lines(t.id)).length;
    const refused = await send("agent", t.number, { kind: "public", body: "All set up for you.", then_status: "solved" });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual([refused.body.error, refused.body.code], [NEEDS, "solve_requirements"]);
    assert.equal((await lines(t.id)).length, before, "no reply was posted");
    const ok = await send("agent", t.number, { kind: "public", body: "All set up for you.", then_status: "solved", solve_fields: { setup_complete: true } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "solved");
    assert.ok((await eventOf(t.id)).setup_done_at);
    // A reply that does not solve is never asked.
    const t2 = await eventTicket("Send pending", 9);
    assert.equal((await send("agent", t2.number, { kind: "public", body: "Which room?", then_status: "pending" })).status, 201);
  });

  test("a macro, an automation and bulk edit: a person's macro is refused whole, an automation keeps the rest of its change, bulk skips the ticket", async () => {
    const t = await eventTicket("Macro", 10);
    const macro = await macros.createMacro({ title: `${STAMP} close`, body: "Glad that worked.", actions: { status: "solved", priority: "high" }, team_id: null, owner_id: P.agent.id }, P.agent.id);
    const before = (await lines(t.id)).length;
    const viaRoute = await call(macroRoute.POST, req(`/tickets/${t.number}/macro/${macro.id}`, P.agent.session, {}), { number: String(t.number), macroId: String(macro.id) });
    assert.equal(viaRoute.status, 409, JSON.stringify(viaRoute.body));
    assert.equal(viaRoute.body.error, NEEDS);
    assert.equal((await lines(t.id)).length, before, "nothing posted");
    const auto = await macros.applyMacroToTicket(t.id, macro.id, { id: null, name: "Automation: thanks" }, { fromAutomation: true });
    assert.ok(auto.ok, JSON.stringify(auto));
    assert.equal(auto.ok ? auto.status_unchanged : "", NEEDS);
    let r = await rowOf(t.id);
    assert.deepEqual([r.status, r.priority], ["open", "high"], "the priority applied, the status did not");

    const rule = (actions: Record<string, unknown>) => ({ id: 0, name: `${STAMP} rule`, actions }) as never;
    assert.equal(await automations.applyRule(rule({ status: "solved", priority: "urgent" }), await rowOf(t.id)), true);
    r = await rowOf(t.id);
    assert.deepEqual([r.status, r.priority], ["open", "urgent"]);
    await assert.rejects(tickets.updateTicket(t.id, { status: "solved" }, { id: null, name: "Automation: close" }, { fromAutomation: true }), new RegExp(`^Error: ${NEEDS.replace(/[.:]/g, "\\$&")}$`));

    const free = await ticket("Bulk free");
    const bulk = await call(bulkRoute.POST, req("/tickets/bulk", P.agent.session, { numbers: [t.number, free.number], patch: { status: "solved" } }));
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.deepEqual(bulk.body.results.map((x: { ok: boolean }) => x.ok), [false, true]);
    assert.equal(bulk.body.results[0].error, NEEDS);
    assert.equal(await statusOf(t.id), "open");
  });

  test("a workflow's Finish step leaves the request open with a note; a workflow task ticket with an event is held too; a declined request's event is cancelled", async () => {
    const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} Flow` });
    const def = workflows.parseWorkflowDefinition({ steps: [{ key: "tell", kind: "notify", title: "Tell the requester", to: "requester", message: "On it." }, { key: "done", kind: "finish", title: "Done", csat: false }] as HdWorkflowStepB[] });
    assert.ok(meta.ok && def.ok, JSON.stringify([meta, def]));
    if (!meta.ok || !def.ok) return;
    const wf = await workflows.createWorkflow(meta.value, def.value);
    workflowIds.push(wf.id);
    const form: HdFormField[] = [{ key: "starts", label: "When does it start?", type: "datetime", required: true }];
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Room with flow`, team_id: T.A, workflow_id: wf.id, form, calendar: { enabled: true, start_field: "starts", lead_minutes: 45 } });
    assert.ok(input.ok, !input.ok ? input.error : "");
    if (!input.ok) return;
    const rt = await requestTypes.createRequestType(input.value);
    typeIds.push(rt.id);
    assert.ok((await workflows.publishWorkflow(wf.id)).ok);
    const t = await tickets.createTicket(
      { subject: `${STAMP} flow request`, body: "Hello", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: rt.id, answers: { starts: "2031-05-01T10:00" } },
      { silent: true, actorId: P.req.id, actorName: P.req.name }
    );
    ticketIds.push(t.id);
    assert.equal((await pool().query("SELECT state FROM hd_workflow_runs WHERE ticket_id = $1", [t.id])).rows[0].state, "done");
    assert.notEqual(await statusOf(t.id), "solved", "the Finish step did not solve it");
    assert.ok((await lines(t.id)).some((l) => l.kind === "internal" && /^The workflow has finished, but the request stays open: Before you solve, this ticket needs\\?: the event setup marked complete/.test(l.body)), JSON.stringify(await lines(t.id)));
    assert.equal((await patch("agent", t.number, { status: "solved", setup_complete: true })).status, 200);

    const task = await ticket("Task", "A", "open", { source: "workflow" });
    assert.equal((await putEvent("agent", task.number, when(11))).status, 200);
    await assert.rejects(tickets.updateTicket(task.id, { status: "solved" }, actor()), /the event setup marked complete/);
    assert.equal(await statusOf(task.id), "open");

    const declined = await eventTicket("Declined", 12);
    await withTx((c) => cal.cancelEventForDeclineTx(c, declined.id, new Date()));
    assert.ok((await eventOf(declined.id)).cancelled_at);
    assert.ok((await lines(declined.id)).some((l) => l.body === "The event was cancelled because the request was declined."));
    assert.equal(await cal.eventSetupOpen(declined.id), false);
  });

  test("solved → closed and retention's auto-close: an event added to a solved ticket holds it until setup is marked; a cancelled event holds nothing", async () => {
    const t = await ticket("Solved first", "A", "solved");
    assert.equal((await putEvent("agent", t.number, when(13))).status, 200, "an event can be added to a solved ticket");
    const r = await patch("agent", t.number, { status: "closed" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, NEEDS);
    const plain = await ticket("Solved plain", "A", "solved");
    await pool().query("UPDATE hd_tickets SET solved_at = now() - interval '30 days' WHERE id = ANY($1)", [[t.id, plain.id]]);
    const settings = { ...(await retention.getRetentionSettings()), auto_close_enabled: true, auto_close_days: 7, retention_enabled: false };
    let run = await retention.runRetention({ settings, only: [t.id, plain.id] });
    assert.deepEqual(run.closed, [plain.id], "the event ticket is not closed early");
    assert.equal(await statusOf(t.id), "solved");
    const plan = await retention.planRetention({ settings, only: [t.id], at: new Date() });
    assert.equal(plan.counts.close, 0, "the preview says the same");
    // Cancelled: nothing is held.
    await cal.cancelTicketEvent(t.id, { id: null, name: "Helpdesk" }, "Cancelled for the test.");
    run = await retention.runRetention({ settings, only: [t.id] });
    assert.deepEqual(run.closed, [t.id]);
    // And marked complete: the same.
    const t2 = await ticket("Solved marked", "A", "solved");
    await putEvent("agent", t2.number, when(14));
    await setup("agent", t2.number, true);
    await pool().query("UPDATE hd_tickets SET solved_at = now() - interval '30 days' WHERE id = $1", [t2.id]);
    assert.deepEqual((await retention.runRetention({ settings, only: [t2.id] })).closed, [t2.id]);
    assert.equal((await patch("agent", (await ticket("Open cancelled")).number, { status: "solved" })).status, 200);
  });

  test("an event in the past whose setup was never marked still blocks, and is listed for the admins", async () => {
    const t = await ticket("Forgotten");
    await pool().query(
      "INSERT INTO hd_ticket_events (ticket_id, starts_at, ends_at, ready_at, place, place_key) VALUES ($1, now() - interval '3 days', now() - interval '3 days' + interval '1 hour', now() - interval '3 days', $2, lower($2))",
      [t.id, `Old hall ${STAMP}`]
    );
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 409);
    const page = await call(adminRoute.GET, req("/admin/calendar", P.dadmin.session));
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const mine = page.body.overdue.find((o: { number: number }) => o.number === t.number);
    assert.deepEqual([mine.subject, mine.place, mine.status], [`Forgotten ${STAMP}`, `Old hall ${STAMP}`, "Open"]);
    assert.equal((await call(adminRoute.GET, req("/admin/calendar", P.agent.session))).status, 403, "the list is for those who run the settings");
    await setup("agent", t.number, true);
    const after = await call(adminRoute.GET, req("/admin/calendar", P.dadmin.session));
    assert.ok(!after.body.overdue.some((o: { number: number }) => o.number === t.number));
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 200);
  });

  test("a merge: the merged ticket's event carries on on the kept ticket, which is then held; a kept ticket's own event wins", async () => {
    const keep = await ticket("Keep");
    const dup = await eventTicket("Dup", 15);
    const r = await merge.mergeTickets({ id: P.agent.id, role: "viewer", name: P.agent.name }, { keep: keep.number, merge: [dup.number], notify: false });
    assert.equal(r.merged.length, 1);
    assert.equal(await statusOf(dup.id), "closed", "a merge is never asked");
    assert.equal(await eventOf(dup.id), undefined);
    assert.equal((await eventOf(keep.id)).place, `Room 15 ${STAMP}`);
    assert.equal((await patch("agent", keep.number, { status: "solved" })).status, 409);
    const keep2 = await eventTicket("Keep with its own", 16);
    const dup2 = await eventTicket("Dup with its own", 17);
    await merge.mergeTickets({ id: P.agent.id, role: "viewer", name: P.agent.name }, { keep: keep2.number, merge: [dup2.number], notify: false });
    assert.equal((await eventOf(keep2.id)).place, `Room 16 ${STAMP}`);
    assert.equal((await eventOf(dup2.id)).place, `Room 17 ${STAMP}`, "it stays on the merged ticket, which is on no calendar");
    const data = await cal.calendarData({ id: P.agent.id, role: "viewer" }, { from: "2031-03-17", to: "2031-03-19", tz: "UTC" });
    assert.deepEqual(data.events.map((e) => e.number), [keep2.number]);
  });

  test("anonymising a ticket clears the event's place and its invite id; the times stay", async () => {
    const t = await eventTicket("Anon", 18);
    await pool().query("UPDATE hd_ticket_events SET ics_uid = 'uid-1' WHERE ticket_id = $1", [t.id]);
    await setup("agent", t.number, true);
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() WHERE id = $1", [t.id]);
    await withTx((c) => retention.anonymiseTicketTx(c, t.id));
    const e = await eventOf(t.id);
    assert.deepEqual([e.place, e.place_key, e.ics_uid, iso(e.starts_at)], ["", "", "", when(18).starts_at]);
  });
});

// =======================================================================================

describe("request types that go on the calendar", () => {
  const FORM: HdFormField[] = [
    { key: "starts", label: "When does it start?", type: "datetime", required: true },
    { key: "ends", label: "When does it end?", type: "datetime" },
    { key: "room", label: "Which room?", type: "select", options: [{ value: "a", label: "Boardroom A" }, { value: "b", label: "Training room" }] },
    { key: "first_day", label: "First day", type: "date" },
    { key: "last_day", label: "Last day", type: "date" },
    { key: "notes", label: "Anything else?", type: "textarea" },
  ];

  test("the settings are checked against the form: a start question of the right kind, an end of the same kind, a place that is a short answer or a pick-one", () => {
    const c = (v: unknown) => shared.checkRequestTypeCalendar(v, FORM);
    assert.deepEqual(c(null), { ok: true, value: { enabled: false, start_field: "", end_field: "", place_field: "", lead_minutes: 30 } });
    assert.equal(c({ enabled: true }).ok, false, "on needs a start");
    assert.equal(c({ enabled: true, start_field: "notes" }).ok, false);
    assert.equal(c({ enabled: true, start_field: "starts", end_field: "last_day" }).ok, false, "a date and time start with a date end");
    assert.equal(c({ enabled: true, start_field: "starts", end_field: "starts" }).ok, false);
    assert.equal(c({ enabled: true, start_field: "starts", place_field: "notes" }).ok, false);
    assert.equal(c({ enabled: true, start_field: "starts", lead_minutes: 99999 }).ok, false);
    assert.deepEqual(c({ enabled: true, start_field: "starts", end_field: "ends", place_field: "room", lead_minutes: 45 }), { ok: true, value: { enabled: true, start_field: "starts", end_field: "ends", place_field: "room", lead_minutes: 45 } });
    // Off: stale choices are dropped quietly, never an error.
    assert.deepEqual(c({ enabled: false, start_field: "gone", lead_minutes: 60 }), { ok: true, value: { enabled: false, start_field: "", end_field: "", place_field: "", lead_minutes: 60 } });
  });

  test("the form's date and time answers: checked, and read in the requester's own zone; whole days from date questions; odd answers fall back with a note", async () => {
    assert.equal((await requestTypes.validateAnswers(FORM, { starts: "2031-06-10 10:00" })).ok, false);
    assert.equal((await requestTypes.validateAnswers(FORM, { starts: "2031-02-30T10:00" })).ok, false);
    const ok = await requestTypes.validateAnswers(FORM, { starts: "2031-06-10T10:00:00", ends: "2031-06-10T12:00" });
    assert.deepEqual(ok.ok && ok.value, { starts: "2031-06-10T10:00", ends: "2031-06-10T12:00" });
    assert.equal(requestTypes.answerText(FORM[0], "2031-06-10T10:00"), "2031-06-10 10:00");
    const cfg = { enabled: true, start_field: "starts", end_field: "ends", place_field: "room", lead_minutes: 45 };
    const e = cal.eventFromAnswers(cfg, FORM, { starts: "2031-06-10T10:00", ends: "2031-06-10T12:00", room: "a" }, "America/New_York")!;
    assert.deepEqual(e, { input: { starts_at: "2031-06-10T14:00:00.000Z", ends_at: "2031-06-10T16:00:00.000Z", timezone: "America/New_York", place: "Boardroom A", setup_minutes: 45 }, note: null });
    const noEnd = cal.eventFromAnswers({ ...cfg, end_field: "" }, FORM, { starts: "2031-06-10T10:00" }, "UTC")!;
    assert.equal(noEnd.input.ends_at, "2031-06-10T11:00:00.000Z", "one hour");
    const backwards = cal.eventFromAnswers(cfg, FORM, { starts: "2031-06-10T10:00", ends: "2031-06-10T09:00" }, "UTC")!;
    assert.equal(backwards.input.ends_at, "2031-06-10T11:00:00.000Z");
    assert.match(backwards.note!, /not after the start/);
    const days = cal.eventFromAnswers({ enabled: true, start_field: "first_day", end_field: "last_day", place_field: "", lead_minutes: 0 }, FORM, { first_day: "2031-06-10", last_day: "2031-06-12" }, "Europe/London")!;
    assert.deepEqual(days.input, { all_day: true, start_date: "2031-06-10", end_date: "2031-06-12", timezone: "Europe/London", place: "", setup_minutes: 0 });
    assert.equal(cal.eventFromAnswers(cfg, FORM, { room: "a" }, "UTC"), null, "no start, no event");
    assert.equal(cal.eventFromAnswers({ ...cfg, enabled: false }, FORM, { starts: "2031-06-10T10:00" }, "UTC"), null);
  });

  test("the admin saves it with the type; a request raised through the type creates its ticket with the event filled in", async () => {
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Room setup`, team_id: T.A, form: FORM });
    assert.ok(input.ok, !input.ok ? input.error : "");
    if (!input.ok) return;
    const rt = await requestTypes.createRequestType(input.value);
    typeIds.push(rt.id);
    assert.deepEqual(shared.resolveRequestTypeCalendar(rt.calendar).enabled, false, "off unless switched on");
    const bad = await call(typeRoute.PATCH, req(`/admin/request-types/${rt.id}`, P.dadmin.session, { calendar: { enabled: true, start_field: "notes" } }, "PATCH"), { id: String(rt.id) });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /choose the question that holds the start/);
    const saved = await call(typeRoute.PATCH, req(`/admin/request-types/${rt.id}`, P.dadmin.session, { calendar: { enabled: true, start_field: "starts", end_field: "ends", place_field: "room", lead_minutes: 45 } }, "PATCH"), { id: String(rt.id) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const stored = (await requestTypes.getRequestType(rt.id))!;
    assert.deepEqual(stored.calendar, { enabled: true, start_field: "starts", end_field: "ends", place_field: "room", lead_minutes: 45 });
    // A later save that leaves `calendar` out keeps it; one that removes the start question is refused.
    assert.equal((await call(typeRoute.PATCH, req(`/admin/request-types/${rt.id}`, P.dadmin.session, { description: "Rooms and video." }, "PATCH"), { id: String(rt.id) })).status, 200);
    assert.equal(shared.resolveRequestTypeCalendar((await requestTypes.getRequestType(rt.id))!.calendar).enabled, true);
    assert.equal((await call(typeRoute.PATCH, req(`/admin/request-types/${rt.id}`, P.dadmin.session, { form: FORM.slice(1) }, "PATCH"), { id: String(rt.id) })).status, 400);

    // The requester's account is on New York time: 10:00 on the form is 10:00 there.
    const t = await tickets.createTicket(
      { subject: `${STAMP} Q3 all-hands`, body: "Please set up the room.", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: rt.id, answers: { starts: "2031-06-10T10:00", ends: "2031-06-10T12:00", room: "a" } },
      { silent: true, actorId: P.req.id, actorName: P.req.name }
    );
    ticketIds.push(t.id);
    const e = await eventOf(t.id);
    assert.deepEqual([iso(e.starts_at), iso(e.ends_at), iso(e.ready_at), e.place, e.setup_minutes, e.source, e.timezone], ["2031-06-10T14:00:00.000Z", "2031-06-10T16:00:00.000Z", "2031-06-10T13:15:00.000Z", "Boardroom A", 45, "request", "America/New_York"]);
    assert.ok((await lines(t.id)).some((l) => l.kind === "internal" && l.body === `Event added from the request: ${md(said("2031-06-10T14:00:00Z", "2031-06-10T16:00:00Z"))} at Boardroom A. Setup ready by ${md(clock("2031-06-10T13:15:00Z"))} (45 minutes before).`), JSON.stringify(await lines(t.id)));
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 409, "and it is held until setup is complete");
    // Without a start answer (an optional question on another type) no event is made; a type that is off makes none.
    const input2 = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Plain type`, team_id: T.A, form: FORM });
    if (!input2.ok) return;
    const plainType = await requestTypes.createRequestType(input2.value);
    typeIds.push(plainType.id);
    const t2 = await tickets.createTicket({ subject: `${STAMP} plain`, body: "x", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: plainType.id, answers: { starts: "2031-06-10T10:00" } }, { silent: true });
    ticketIds.push(t2.id);
    assert.equal(await eventOf(t2.id), undefined);
  });
});

// =======================================================================================

describe("meeting invites by email", () => {
  const icsText = (method: string, uid: string, lines: string[]) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", `UID:${uid}`, ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  function mail(over: Partial<InboundEmail> = {}): InboundEmail {
    return {
      provider: "generic",
      from: { email: P.req.email, name: "Req Person" },
      to: [{ email: ALIAS, name: "" }],
      cc: [],
      recipients: [],
      subject: `${STAMP} Board meeting`,
      text: "Please set the room up for this.",
      html: "",
      stripped: "",
      messageId: `${newToken()}@mail.example.test`,
      inReplyTo: "",
      references: [],
      headers: {},
      auth: { dmarc: "pass" },
      files: [],
      ...over,
    };
  }
  const file = (text: string, name = "invite.ics", type = "text/calendar; method=REQUEST") => ({ name, type, data: Buffer.from(text, "utf8") });
  const byNumber = async (n: number) => (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n])).rows[0];
  const UID = `${STAMP}-meeting-1@calendar.example.test`;

  test("an invite creates the ticket as before and fills in its event; the .ics is not listed as a refused attachment", async () => {
    const r = await inbound.processInboundEmail(
      mail({ files: [file(icsText("REQUEST", UID, ["SEQUENCE:0", "DTSTART;TZID=America/New_York:20310710T100000", "DTEND;TZID=America/New_York:20310710T113000", "SUMMARY:Board meeting", "LOCATION:Boardroom A"]))] }),
      { outsideSenders: false }
    );
    assert.deepEqual([r.status, r.body.outcome], [200, "created"]);
    const t = await byNumber(r.body.ticket!);
    ticketIds.push(t.id);
    assert.deepEqual([t.team_id, t.subject, t.source, t.status], [T.A, `${STAMP} Board meeting`, "email", "new"]);
    const e = await eventOf(t.id);
    assert.deepEqual([iso(e.starts_at), iso(e.ends_at), e.place, e.source, e.ics_uid, e.ics_sequence, e.setup_minutes, e.timezone], ["2031-07-10T14:00:00.000Z", "2031-07-10T15:30:00.000Z", "Boardroom A", "invite", UID, 0, 30, "America/New_York"]);
    const ls = await lines(t.id);
    assert.ok(ls.some((l) => l.kind === "internal" && l.body.startsWith(`Event added from the meeting invite ${P.req.name} sent: ${md(said("2031-07-10T14:00:00Z", "2031-07-10T15:30:00Z"))} at Boardroom A.`)), JSON.stringify(ls));
    assert.ok(!ls.some((l) => /not added from the email/.test(l.body)), "the invite is not reported as a file that could not be added");
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 409, "held until setup is complete");
  });

  test("an update for the same meeting (the same UID, sent as new mail) updates the event on that ticket; an older one is ignored", async () => {
    const t = (await pool().query("SELECT t.* FROM hd_tickets t JOIN hd_ticket_events e ON e.ticket_id = t.id WHERE e.ics_uid = $1", [UID])).rows[0];
    const upd = await inbound.processInboundEmail(
      mail({ subject: `${STAMP} Board meeting (moved)`, files: [file(icsText("REQUEST", UID, ["SEQUENCE:2", "DTSTART:20310711T150000Z", "DTEND:20310711T160000Z", "LOCATION:Boardroom B"]))] }),
      { outsideSenders: false }
    );
    assert.deepEqual([upd.body.outcome, upd.body.ticket], ["appended", t.number], "no second ticket");
    let e = await eventOf(t.id);
    assert.deepEqual([iso(e.starts_at), e.place, e.ics_sequence, e.time_rev], ["2031-07-11T15:00:00.000Z", "Boardroom B", 2, 2]);
    assert.ok((await lines(t.id)).some((l) => l.body.startsWith(`Event updated from the meeting invite ${P.req.name} sent: ${md(said("2031-07-11T15:00:00Z", "2031-07-11T16:00:00Z"))}`)));
    const stale = await inbound.processInboundEmail(mail({ files: [file(icsText("REQUEST", UID, ["SEQUENCE:1", "DTSTART:20310801T150000Z"]))] }), { outsideSenders: false });
    assert.equal(stale.body.outcome, "appended");
    e = await eventOf(t.id);
    assert.deepEqual([iso(e.starts_at), e.ics_sequence], ["2031-07-11T15:00:00.000Z", 2], "an older revision changes nothing");
    // The same UID from somebody else is their own mail: a ticket of their own, and this event untouched.
    const other = await inbound.processInboundEmail(
      mail({ from: { email: P.agent2.email, name: "Agent Two" }, subject: `${STAMP} hijack`, files: [file(icsText("REQUEST", UID, ["SEQUENCE:9", "DTSTART:20350101T150000Z", "LOCATION:Nowhere"]))] }),
      { outsideSenders: false }
    );
    assert.equal(other.body.outcome, "created");
    assert.notEqual(other.body.ticket, t.number);
    ticketIds.push((await byNumber(other.body.ticket!)).id);
    assert.equal((await eventOf(t.id)).place, "Boardroom B");
  });

  test("a cancellation marks the event cancelled with an agents-only note, never closes the ticket, and frees it to be solved", async () => {
    const t = (await pool().query("SELECT t.* FROM hd_tickets t JOIN hd_ticket_events e ON e.ticket_id = t.id WHERE e.ics_uid = $1 ORDER BY t.id LIMIT 1", [UID])).rows[0];
    const r = await inbound.processInboundEmail(mail({ subject: `Canceled: ${STAMP} Board meeting`, files: [file(icsText("CANCEL", UID, ["SEQUENCE:3", "DTSTART:20310711T150000Z"]), "cancel.ics", "text/calendar; method=CANCEL")] }), { outsideSenders: false });
    assert.deepEqual([r.body.outcome, r.body.ticket], ["appended", t.number]);
    const e = await eventOf(t.id);
    assert.ok(e.cancelled_at);
    const after = await byNumber(t.number);
    assert.ok(["new", "open"].includes(after.status), `the ticket was not closed (${after.status})`);
    const note = (await lines(t.id)).find((l) => l.body.startsWith(`The meeting was cancelled by ${P.req.name}`));
    assert.ok(note && note.kind === "internal", JSON.stringify(await lines(t.id)));
    assert.match(note!.body, /The ticket was not closed\.$/);
    assert.equal(await cal.eventSetupOpen(t.id), false);
    assert.equal((await patch("agent", t.number, { status: "solved" })).status, 200, "a cancelled event no longer blocks");
  });

  test("a repeating invite uses its first date and says so; an all-day invite; SUMMARY stands in for an empty subject; a reply on the thread carrying another meeting changes nothing", async () => {
    const uid = `${STAMP}-weekly@calendar.example.test`;
    const r = await inbound.processInboundEmail(
      mail({ subject: "", files: [file(icsText("REQUEST", uid, ["DTSTART;VALUE=DATE:20310801", "DTEND;VALUE=DATE:20310803", `SUMMARY:${STAMP} Weekly stand-up`, "RRULE:FREQ=WEEKLY"]), "meeting.ics", "application/octet-stream")] }),
      { outsideSenders: false }
    );
    assert.equal(r.body.outcome, "created");
    const t = await byNumber(r.body.ticket!);
    ticketIds.push(t.id);
    assert.equal(t.subject, `${STAMP} Weekly stand-up`);
    const e = await eventOf(t.id);
    assert.deepEqual([e.all_day, e.sd, e.ed, e.repeats], [1, "2031-08-01", "2031-08-02", 1]);
    assert.ok((await lines(t.id)).some((l) => /^The invite is for a meeting that repeats\. Only its first date is on the calendar/.test(l.body)));
    // A token reply with an invite for a different meeting.
    const token = t.reply_token as string;
    const reply = await inbound.processInboundEmail(
      mail({ subject: `Re: [#${t.number} ref:${token}]`, files: [file(icsText("REQUEST", `${STAMP}-other`, ["DTSTART:20320101T100000Z", "LOCATION:Elsewhere"]))] }),
      { outsideSenders: false }
    );
    assert.equal(reply.body.outcome, "appended");
    assert.equal((await eventOf(t.id)).sd, "2031-08-01");
    assert.ok((await lines(t.id)).some((l) => l.body === "This email carried a meeting invite for a different meeting. The ticket's event was not changed."));
    // A cancellation for a meeting no ticket knows: a ticket as any mail, no event.
    const lone = await inbound.processInboundEmail(mail({ subject: `${STAMP} Canceled: unknown`, files: [file(icsText("CANCEL", `${STAMP}-unknown`, ["DTSTART:20320101T100000Z"]))] }), { outsideSenders: false });
    assert.equal(lone.body.outcome, "created");
    const lt = await byNumber(lone.body.ticket!);
    ticketIds.push(lt.id);
    assert.equal(await eventOf(lt.id), undefined);
  });

  test("hostile calendar files never break intake: the ticket is still made, with no event", async () => {
    const hostile: [string, Buffer][] = [
      ["huge", Buffer.concat([Buffer.from("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20310710T100000Z\r\nX:"), Buffer.alloc(1024 * 1024, 66)])],
      ["garbage", Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256))],
      ["lines", Buffer.from("BEGIN:VCALENDAR\r\n" + "A:1\r\n".repeat(20000) + "BEGIN:VEVENT\r\nDTSTART:20310710T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR")],
      ["empty", Buffer.alloc(0)],
      ["reply", Buffer.from(icsText("REPLY", "x", ["DTSTART:20310710T100000Z"]))],
    ];
    for (const [name, data] of hostile) {
      const started = Date.now();
      const r = await inbound.processInboundEmail(mail({ subject: `${STAMP} hostile ${name}`, files: [{ name: `${name}.ics`, type: "text/calendar", data }] }), { outsideSenders: false });
      assert.ok(Date.now() - started < 5000, `${name} took too long`);
      assert.deepEqual([r.status, r.body.outcome], [200, "created"], name);
      const t = await byNumber(r.body.ticket!);
      ticketIds.push(t.id);
      assert.equal(await eventOf(t.id), undefined, name);
    }
    assert.equal(await cal.inviteFromEmail({ files: [{ name: "x.ics", type: "", data: null as never }] }), null);
  });

  test("the generic webhook shape takes the text/calendar part as `calendar`", () => {
    const e = inboundParse.parseGeneric({ from: "a@example.test", to: "b@example.test", subject: "x", text: "y", calendar: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" });
    assert.deepEqual(e.files.map((f) => [f.name, f.type, f.data.toString()]), [["invite.ics", "text/calendar", "BEGIN:VCALENDAR\r\nEND:VCALENDAR"]]);
    assert.equal(inboundParse.parseGeneric({ from: "a@example.test", subject: "x" }).files.length, 0);
  });
});

// =======================================================================================

describe("the Calendar page's data", () => {
  test("an agent sees the events of their teams' tickets and their own; the team filter; ranges are checked", async () => {
    const mine = await eventTicket("Mine", 20);
    const theirs = await eventTicket("Theirs", 20, {}, "B");
    const assigned = await ticket("Assigned to me in B", "B", "open", { assignee: P.agent.id });
    assert.equal((await putEvent("agent", assigned.number, when(21))).status, 200, "their own ticket, whatever its team");
    const get = (who: string, q: string) => call(calendarRoute.GET, req(`/calendar?${q}`, P[who].session));
    const r = await get("agent", "from=2031-03-17&to=2031-03-23");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const numbers = r.body.events.map((e: { number: number }) => e.number);
    assert.ok(numbers.includes(mine.number) && numbers.includes(assigned.number));
    assert.ok(!numbers.includes(theirs.number), "another team's event is not on their calendar");
    assert.deepEqual(r.body.teams, [{ id: T.A, name: `${STAMP} A` }]);
    const e = r.body.events.find((x: { number: number }) => x.number === mine.number);
    assert.deepEqual([e.subject, e.status, e.status_label, e.team_name, e.place, e.setup_minutes, e.ready_at, e.setup_complete, e.cancelled], [`Mine ${STAMP}`, "open", "Open", `${STAMP} A`, `Room 20 ${STAMP}`, 30, "2031-03-21T13:30:00.000Z", false, false]);
    const admin = await get("admin", `from=2031-03-17&to=2031-03-23&team=${T.B}`);
    assert.deepEqual(admin.body.events.map((x: { number: number }) => x.number).sort(), [theirs.number, assigned.number].sort());
    assert.equal((await get("agent", `from=2031-03-17&to=2031-03-23&team=${T.B}`)).body.events.some((x: { number: number }) => x.number === theirs.number), false, "a team they don't work is not a filter they can use");
    assert.equal((await get("agent", "from=2031-03-17")).status, 400);
    assert.equal((await get("agent", "from=2031-03-23&to=2031-03-17")).status, 400);
    assert.equal((await get("agent", "from=2031-01-01&to=2031-12-31")).status, 400);
    assert.equal((await get("req", "from=2031-03-17&to=2031-03-23")).status, 403);
    // The day is cut in the viewer's zone. 14:00 to 15:30 UTC on the 21st is 23:00 to 00:30 in Tokyo: on the 21st and the 22nd there,
    // and only on the 21st in Los Angeles (07:00 to 08:30; its setup from 06:30).
    const on = async (day: string, tz: string) => (await cal.calendarData({ id: P.agent.id, role: "viewer" }, { from: day, to: day, tz })).events.some((x) => x.number === mine.number);
    assert.deepEqual([await on("2031-03-21", "Asia/Tokyo"), await on("2031-03-22", "Asia/Tokyo"), await on("2031-03-23", "Asia/Tokyo")], [true, true, false]);
    assert.deepEqual([await on("2031-03-20", "America/Los_Angeles"), await on("2031-03-21", "America/Los_Angeles"), await on("2031-03-22", "America/Los_Angeles")], [false, true, false]);
  });

  test("the layers: due dates of the viewer's open tickets, and the tickets recurring schedules will open", async () => {
    const due = await ticket("Due soon");
    await pool().query("UPDATE hd_tickets SET first_reply_due = '2031-09-02T10:00:00Z', resolve_due = '2031-09-04T10:00:00Z' WHERE id = $1", [due.id]);
    const paused = await ticket("Paused", "A", "pending");
    await pool().query("UPDATE hd_tickets SET resolve_due = '2031-09-02T12:00:00Z', sla_paused_at = now() WHERE id = $1", [paused.id]);
    const other = await ticket("Other team due", "B");
    await pool().query("UPDATE hd_tickets SET resolve_due = '2031-09-02T12:00:00Z' WHERE id = $1", [other.id]);
    const sched = await recurring.createRecurring(
      { team_id: T.A, subject: `${STAMP} Check the projector`, body: "", priority: "normal", request_type_id: null, assign_mode: "team_rules", assignee_id: null, due_business_days: null, pattern: { kind: "weekly", days: [2], time: "09:00" }, holiday_rule: "same_day", timezone: "Europe/London", enabled: true },
      P.admin.id
    );
    recurringIds.push(sched.id);
    const now = new Date("2031-08-30T00:00:00Z");
    const off = await cal.calendarData({ id: P.agent.id, role: "viewer" }, { from: "2031-09-01", to: "2031-09-07", tz: "UTC", now });
    assert.deepEqual([off.due, off.recurring], [[], []], "layers are off unless asked for");
    const on = await cal.calendarData({ id: P.agent.id, role: "viewer" }, { from: "2031-09-01", to: "2031-09-07", tz: "UTC", layers: ["due", "recurring"], now });
    assert.deepEqual(on.due.map((d) => [d.number, d.at, d.kind, d.overdue]), [[due.number, "2031-09-02T10:00:00.000Z", "first_reply", false]], "the next running target; not a paused clock; not another team's");
    assert.deepEqual(on.recurring.map((r) => [r.title, r.at, r.team_name]), [[`${STAMP} Check the projector`, "2031-09-02T08:00:00.000Z", `${STAMP} A`]], "Tuesday 09:00 London (summer time)");
    const viaRoute = await call(calendarRoute.GET, req("/calendar?from=2031-09-01&to=2031-09-07&layers=due,recurring,nonsense", P.agent.session));
    assert.equal(viaRoute.body.recurring.length, 1);
    assert.equal((await cal.calendarData({ id: P.other.id, role: "viewer" }, { from: "2031-09-01", to: "2031-09-07", tz: "UTC", layers: ["recurring"], now })).recurring.length, 0);
  });

  test("an overlap is flagged on the calendar, naming only tickets the viewer may see; what a person chose is remembered", async () => {
    const place = `Lab ${STAMP}`;
    const a = await ticket("Lab one");
    const b = await ticket("Lab two");
    const c = await ticket("Lab three", "B");
    for (const [who, t] of [["agent", a], ["agent", b], ["other", c]] as const) assert.equal((await putEvent(who, t.number, { starts_at: "2031-10-01T10:00:00Z", ends_at: "2031-10-01T11:00:00Z", place })).status, 200);
    const data = await cal.calendarData({ id: P.agent.id, role: "viewer" }, { from: "2031-10-01", to: "2031-10-01", tz: "UTC" });
    const ea = data.events.find((e) => e.number === a.number)!;
    assert.deepEqual([...ea.conflicts].sort(), [b.number, null].sort());
    const prefs = await call(prefsRoute.GET, req("/calendar/prefs", P.agent.session));
    assert.deepEqual(prefs.body.prefs, { view: "week", team_id: 0, colour: "team", layers: [] });
    const put = await call(prefsRoute.PUT, req("/calendar/prefs", P.agent.session, { view: "month", colour: "status", layers: ["recurring", "bogus", "due"], team_id: T.A }, "PUT"));
    assert.deepEqual(put.body.prefs, { view: "month", team_id: T.A, colour: "status", layers: ["due", "recurring"] });
    assert.deepEqual((await call(prefsRoute.PUT, req("/calendar/prefs", P.agent.session, { view: "year" }, "PUT"))).body.prefs.view, "week", "an unknown view is the default");
    assert.deepEqual((await call(prefsRoute.GET, req("/calendar/prefs", P.agent2.session))).body.prefs.view, "week", "each person has their own");
  });
});

// =======================================================================================

describe("reminders", () => {
  const sweep = (now: string, ids: number[]) => reminders.eventReminderSweep(new Date(now), { only: ids });
  const got = (n: number) => deliveries.filter((d) => d.title.startsWith(`#${n}:`));

  test("which reminders are due: from each lead time until the setup is due; the nearest first; late once the event has started", () => {
    const e = { ready_at: "2031-11-20T13:30:00Z", starts_at: "2031-11-20T14:00:00Z" };
    const s = { reminder_minutes: [1440, 60], late_reminder: true };
    const at = (iso: string) => reminders.dueKinds(e, s, Date.parse(iso));
    assert.deepEqual(at("2031-11-19T13:29:00Z"), []);
    assert.deepEqual(at("2031-11-19T13:30:00Z"), ["lead:1440"]);
    assert.deepEqual(at("2031-11-20T12:30:00Z"), ["lead:60", "lead:1440"]);
    assert.deepEqual(at("2031-11-20T13:30:00Z"), [], "between ready-by and the start nothing new is due");
    assert.deepEqual(at("2031-11-20T14:00:00Z"), ["late"]);
    assert.deepEqual(at("2031-11-21T14:00:00Z"), [], "a day after the start it is too late to be useful");
    assert.deepEqual(reminders.dueKinds(e, { ...s, late_reminder: false }, Date.parse("2031-11-20T14:00:00Z")), []);
    assert.equal(reminders.reminderHeadline("lead:60", e, Date.parse("2031-11-20T12:30:40Z")), "Setup due in 1 hour");
    assert.equal(reminders.reminderHeadline("lead:1440", e, Date.parse("2031-11-19T13:31:00Z")), "Setup due in 1 day");
    assert.equal(reminders.reminderHeadline("late", e, 0), "The event has started and setup isn't marked complete");
  });

  test("sent once each to the owner, else the team; a second sweep and a second instance send nothing; the sweep is registered", async () => {
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_event_reminders"));
    assert.ok(prefsShared.HD_NOTIFY_EVENTS.includes("event_reminder"));
    const ev = policy.NOTIFY_EVENTS.find((x) => x.id === "desk_event_reminder");
    assert.deepEqual(ev?.templates, ["hd_event_reminder"]);
    assert.ok(templates.SAMPLE_VARS.hd_event_reminder && email.HD_AGENT_ONLY_TEMPLATES.has("hd_event_reminder"));

    const owned = await ticket("Owned", "A", "open", { assignee: P.agent.id });
    const unowned = await ticket("Unowned");
    for (const t of [owned, unowned]) assert.equal((await putEvent("agent", t.number, { starts_at: "2031-11-20T14:00:00Z", ends_at: "2031-11-20T15:00:00Z", place: "Boardroom A", setup_minutes: 30 })).status, 200);
    const ids = [owned.id, unowned.id];
    deliveries.length = 0;
    assert.deepEqual((await sweep("2031-11-19T13:00:00Z", ids)).sent, [], "not yet");
    const first = await sweep("2031-11-19T13:30:30Z", ids);
    assert.deepEqual(first.sent.map((s) => [s.ticket_id, s.kind, s.recipients]).sort(), [[owned.id, "lead:1440", 1], [unowned.id, "lead:1440", 3]].sort());
    assert.deepEqual(got(owned.number).map((d) => [d.userId, d.event, d.title, d.email, d.urgent]), [[P.agent.id, "event_reminder", `#${owned.number}: Setup due in 1 day`, "hd_event_reminder", false]]);
    assert.equal(got(owned.number)[0].body, `Owned ${STAMP} · ${said("2031-11-20T14:00:00Z", "2031-11-20T15:00:00Z")} · Boardroom A`);
    assert.deepEqual(got(unowned.number).map((d) => d.userId).sort(), [P.agent.id, P.agent2.id, P.lead.id].sort(), "nobody owns it: the team");
    // Again, and from "another instance" at the same moment: nothing more.
    deliveries.length = 0;
    const again = await Promise.all([sweep("2031-11-19T13:31:00Z", ids), sweep("2031-11-19T13:31:00Z", ids), sweep("2031-11-19T14:00:00Z", ids)]);
    assert.deepEqual(again.flatMap((r) => r.sent), []);
    assert.equal(deliveries.length, 0);
    // The hour reminder, once, though two sweeps race for it.
    const raced = await Promise.all([sweep("2031-11-20T12:30:10Z", ids), sweep("2031-11-20T12:30:10Z", ids)]);
    assert.equal(raced.flatMap((r) => r.sent).filter((s) => s.ticket_id === owned.id).length, 1);
    assert.equal(got(owned.number).length, 1);
    assert.equal(got(owned.number)[0].title, `#${owned.number}: Setup due in 1 hour`);
    const rows = (await pool().query("SELECT kind, time_rev, recipients FROM hd_event_reminders WHERE ticket_id = $1 ORDER BY kind", [owned.id])).rows;
    assert.deepEqual(rows, [{ kind: "lead:1440", time_rev: 1, recipients: 1 }, { kind: "lead:60", time_rev: 1, recipients: 1 }], "what was sent is on record");
  });

  test("re-armed when the time changes; skipped for a cancelled event, a complete setup and a solved ticket; late goes to the owner and the leads", async () => {
    const t = await ticket("Rearm", "A", "open", { assignee: P.agent2.id });
    await putEvent("agent", t.number, { starts_at: "2031-12-10T14:00:00Z", ends_at: "2031-12-10T15:00:00Z", setup_minutes: 60 });
    deliveries.length = 0;
    assert.equal((await sweep("2031-12-10T12:10:00Z", [t.id])).sent.length, 1, "added late: only the nearest reminder goes out");
    assert.deepEqual(got(t.number).map((d) => d.title), [`#${t.number}: Setup due in 50 minutes`]);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_event_reminders WHERE ticket_id = $1", [t.id])).rows[0].n, 2, "the day reminder counts as sent too");
    // Moved to the next day: the reminders are due again for the new time.
    await putEvent("agent", t.number, { starts_at: "2031-12-11T14:00:00Z" });
    deliveries.length = 0;
    assert.equal((await sweep("2031-12-10T13:30:00Z", [t.id])).sent[0].kind, "lead:1440");
    assert.equal((await sweep("2031-12-11T12:00:30Z", [t.id])).sent[0].kind, "lead:60");
    assert.equal(got(t.number).length, 2);
    // Started, setup still open: the owner and the team's lead, urgent, once.
    deliveries.length = 0;
    const late = await sweep("2031-12-11T14:00:30Z", [t.id]);
    assert.deepEqual(late.sent.map((s) => [s.kind, s.recipients]), [["late", 2]]);
    assert.deepEqual(got(t.number).map((d) => [d.userId, d.urgent]).sort(), [[P.agent2.id, true], [P.lead.id, true]].sort());
    assert.match(got(t.number)[0].title, /The event has started and setup isn't marked complete$/);
    assert.deepEqual((await sweep("2031-12-11T14:05:00Z", [t.id])).sent, []);

    const skipped: number[] = [];
    const cancelled = await ticket("Cancelled", "A", "open", { assignee: P.agent.id });
    const complete = await ticket("Complete", "A", "open", { assignee: P.agent.id });
    const solved = await ticket("Solved", "A", "open", { assignee: P.agent.id });
    for (const x of [cancelled, complete, solved]) {
      await putEvent("agent", x.number, { starts_at: "2032-01-10T14:00:00Z", ends_at: "2032-01-10T15:00:00Z", setup_minutes: 0 });
      skipped.push(x.id);
    }
    await cal.cancelTicketEvent(cancelled.id, { id: null, name: "Helpdesk" }, "Cancelled.");
    await setup("agent", complete.number, true);
    await pool().query("UPDATE hd_tickets SET status = 'solved' WHERE id = $1", [solved.id]);
    deliveries.length = 0;
    for (const now of ["2032-01-09T14:00:30Z", "2032-01-10T13:00:30Z", "2032-01-10T14:00:30Z"]) assert.deepEqual((await sweep(now, skipped)).sent, []);
    assert.equal(deliveries.length, 0);
    // Taking "Setup complete" back makes the event remindable again.
    await setup("agent", complete.number, false);
    assert.equal((await sweep("2032-01-10T13:00:30Z", [complete.id])).sent.length, 1);
  });

  test("the settings: who may, validation, the audit row; no lead times and no late reminder means no reminders; owner and team", async () => {
    const page = await call(adminRoute.GET, req("/admin/calendar", P.dadmin.session));
    assert.deepEqual(page.body.settings, { reminder_minutes: [1440, 60], late_reminder: true, recipients: "owner_else_team", chat: false, default_setup_minutes: 30 }, "the defaults, with nothing stored");
    assert.equal(typeof page.body.chat_connected, "boolean");
    const put = (who: string, body: unknown) => call(adminRoute.PUT, req("/admin/calendar", P[who].session, body, "PUT"));
    assert.equal((await put("agent", { late_reminder: false })).status, 403);
    assert.equal((await put("dadmin", { reminder_minutes: [0] })).status, 400);
    assert.equal((await put("dadmin", { reminder_minutes: [1, 2, 3, 4, 5, 6] })).status, 400);
    assert.equal((await put("dadmin", { recipients: "everyone" })).status, 400);
    assert.equal((await put("dadmin", { default_setup_minutes: -1 })).status, 400);
    assert.deepEqual(shared.resolveCalendarSettings({ reminder_minutes: "x", recipients: 7 }), shared.CALENDAR_SETTINGS_DEFAULTS);
    // The stored settings are shared by everything on this database: the checks below use the pure halves, and a save is
    // made and put straight back.
    const before = await getSetting(cal.HD_CALENDAR_SETTINGS_KEY);
    try {
      const saved = await put("dadmin", { reminder_minutes: [60, 1440, 60], recipients: "owner_and_team" });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual([saved.body.settings.reminder_minutes, saved.body.settings.recipients], [[1440, 60], "owner_and_team"]);
      const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.calendar.settings_updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.dadmin.id])).rows[0];
      assert.deepEqual(audit.details.changed, ["recipients"]);
    } finally {
      if (before === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [cal.HD_CALENDAR_SETTINGS_KEY]);
      else await db.setSetting(cal.HD_CALENDAR_SETTINGS_KEY, before);
    }
    assert.deepEqual((await reminders.reminderRecipients({ team_id: T.A, assignee_id: P.agent.id }, "lead:60", { recipients: "owner_and_team" })).sort(), [P.agent.id, P.agent2.id, P.lead.id].sort());
    assert.deepEqual(await reminders.reminderRecipients({ team_id: T.A, assignee_id: P.agent.id }, "lead:60", { recipients: "owner_else_team" }), [P.agent.id]);
    assert.deepEqual(await reminders.reminderRecipients({ team_id: null, assignee_id: null }, "late", { recipients: "owner_else_team" }), []);
    assert.deepEqual(reminders.dueKinds({ ready_at: "2031-11-20T13:30:00Z", starts_at: "2031-11-20T14:00:00Z" }, { reminder_minutes: [], late_reminder: false }, Date.parse("2031-11-20T13:00:00Z")), []);
  });
});

// =======================================================================================

describe("the private calendar feed", () => {
  /** A timed event `n` + 90 days from today, 14:00 to 15:30 UTC: inside the feed's window, months before any reminder. */
  const soon = (n: number) => {
    const start = Math.floor(Date.now() / 86_400_000) * 86_400_000 + (90 + n) * 86_400_000 + 14 * 3_600_000;
    return { starts_at: new Date(start).toISOString(), ends_at: new Date(start + 90 * 60_000).toISOString() };
  };
  const stamp = (isoTime: string) => isoTime.replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
  const dayOf = (isoTime: string, plus = 0) => new Date(Date.parse(isoTime) + plus * 86_400_000).toISOString().slice(0, 10);
  const fetchFeed = (path: string, ip = "198.51.100.7") => call(feedRoute.GET, new Request(`http://localhost/api/helpdesk/calendar/feed/${path}`, { headers: { "x-forwarded-for": ip } }), { token: path });
  const makeFeed = (who: string, team_id: number | null) => call(feedsRoute.POST, req("/calendar/feeds", P[who].session, { team_id }));
  const tokenOf = (url: string) => url.split("/").pop()!;
  let teamUrl = "";

  test("a link is shown once and stored only as a hash; it works with no session and carries the events, nothing about the requester", async () => {
    const t = await eventTicket("Feed event, with; odd chars", 30, soon(0));
    await pool().query("INSERT INTO hd_messages (ticket_id, author_name, kind, body, via) VALUES ($1, 'Agent', 'internal', $2, 'desk')", [t.id, `SECRET NOTE ${STAMP}`]);
    const d1 = dayOf(soon(2).starts_at);
    const allDay = await eventTicket("Feed offsite", 31, { all_day: true, start_date: d1, end_date: dayOf(soon(2).starts_at, 1), timezone: "Europe/London", starts_at: undefined, ends_at: undefined });
    const cancelled = await eventTicket("Feed cancelled", 32, soon(3));
    await cal.cancelTicketEvent(cancelled.id, { id: null, name: "Helpdesk" }, "Cancelled.");
    const theirs = await eventTicket("Feed other team", 30, soon(0), "B");
    assert.equal((await makeFeed("agent", T.B)).status, 403, "only a team they work");
    assert.equal((await makeFeed("req", null)).status, 403);
    assert.equal((await makeFeed("agent", "x" as never)).status, 400);
    const made = await makeFeed("agent", T.A);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    teamUrl = made.body.url;
    assert.match(teamUrl, /^http:\/\/localhost\/api\/helpdesk\/calendar\/feed\/cdf_[A-Za-z0-9_-]{43}\.ics$/);
    const token = tokenOf(teamUrl).replace(/\.ics$/, "");
    assert.deepEqual([made.body.replaced, made.body.feed.team_name, made.body.feed.hint, made.body.feed.mine], [false, `${STAMP} A`, `cdf_…${token.slice(-4)}`, true]);
    const row = (await pool().query("SELECT token_hash, last4 FROM hd_calendar_feeds WHERE id = $1", [made.body.feed.id])).rows[0];
    assert.equal(row.token_hash, feed.hashFeedToken(token));
    const everything = JSON.stringify((await pool().query("SELECT * FROM hd_calendar_feeds WHERE owner_id = $1", [P.agent.id])).rows) + JSON.stringify((await pool().query("SELECT * FROM audit_log WHERE actor_id = $1", [P.agent.id])).rows);
    assert.ok(!everything.includes(token), "the token is in no row and no audit entry");
    const audit = (await pool().query("SELECT action, target_label, details FROM audit_log WHERE action LIKE 'helpdesk.calendar_feed.%' AND actor_id = $1", [P.agent.id])).rows;
    assert.deepEqual(audit.map((a) => [a.action, a.details.scope]), [["helpdesk.calendar_feed.created", `${STAMP} A`]]);
    const list = await call(feedsRoute.GET, req("/calendar/feeds", P.agent.session));
    assert.ok(!JSON.stringify(list.body).includes(token), "a later read never carries it");
    assert.deepEqual([list.body.feeds.length, list.body.teams, list.body.can_manage], [1, [{ id: T.A, name: `${STAMP} A` }], false]);

    // No cookie at all.
    const got = await fetchFeed(tokenOf(teamUrl));
    assert.equal(got.status, 200, got.text.slice(0, 200));
    assert.match(got.headers.get("content-type") ?? "", /^text\/calendar/);
    assert.equal(got.headers.get("cache-control"), "private, no-store");
    const body = got.text.replace(/\r\n /g, "");
    assert.ok(body.includes(`SUMMARY:#${t.number} Feed event${BS}, with${BS}; odd chars ${STAMP}`), body.slice(0, 1500));
    assert.match(body, new RegExp(`LOCATION:Room 30 ${STAMP}`));
    assert.match(body, new RegExp(`URL:http://localhost/desk/tickets/${t.number}\\r\\n`));
    assert.ok(body.includes(`DTSTART:${stamp(soon(0).starts_at)}${CRLF}DTEND:${stamp(soon(0).ends_at)}`), body.slice(0, 1500));
    assert.ok(body.includes(`DESCRIPTION:Setup ready by 13:30 (UTC)${BS}, 30 minutes before the start.${BS}nSetup complete: not yet.${BS}nTicket: http`), body.slice(0, 1500));
    assert.ok(body.includes(`DTSTART;VALUE=DATE:${d1.replace(/-/g, "")}${CRLF}DTEND;VALUE=DATE:${dayOf(soon(2).starts_at, 2).replace(/-/g, "")}`), "whole days end the day after the last");
    assert.ok(body.includes(`UID:ticket-${allDay.number}@localhost`));
    assert.match(body, new RegExp(`SUMMARY:#${cancelled.number}[\\s\\S]*?STATUS:CANCELLED`));
    assert.ok(!body.includes(`#${theirs.number} `), "another team's event is not in a team's feed");
    for (const leak of [P.req.email, "Req Person", `SECRET NOTE ${STAMP}`, P.agent.email]) assert.ok(!body.includes(leak), `the feed carries ${leak}`);
    assert.ok((await pool().query("SELECT last_used_at FROM hd_calendar_feeds WHERE id = $1", [made.body.feed.id])).rows.length === 1);
  });

  test("every address that is not a working link answers the same 404: malformed, unknown, revoked, replaced; unlicensed is 402 for all", async () => {
    const good = tokenOf(teamUrl);
    const unknown = `cdf_${"A".repeat(43)}.ics`;
    const answers = [await fetchFeed("nonsense"), await fetchFeed(unknown), await fetchFeed(good.slice(0, -5) + "X.ics"), await fetchFeed(`${good}.ics`), await fetchFeed("cdf_.ics"), await fetchFeed("%2e%2e%2f")];
    for (const a of answers) assert.deepEqual([a.status, a.text], [404, "Not found.\n"]);
    assert.equal((await fetchFeed(good.replace(/\.ics$/, ""))).status, 200, "the suffix is optional");
    licensed = false;
    try {
      const a = await fetchFeed(good, "198.51.100.8");
      const b = await fetchFeed(unknown, "198.51.100.8");
      assert.deepEqual([a.status, b.status, a.text], [402, 402, b.text], "nothing tells a real link from a made-up one");
    } finally {
      licensed = true;
    }
    // Replacing a link kills the old address at once.
    const again = await makeFeed("agent", T.A);
    assert.deepEqual([again.status, again.body.replaced], [201, true]);
    assert.notEqual(again.body.url, teamUrl);
    assert.deepEqual([(await fetchFeed(good)).status, (await fetchFeed(tokenOf(again.body.url))).status], [404, 200]);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_calendar_feeds WHERE owner_id = $1 AND team_id = $2 AND revoked_at IS NULL", [P.agent.id, T.A])).rows[0].n, 1, "one live link per person per scope");
    teamUrl = again.body.url;
    // Revoking: only its owner or someone who runs the settings.
    const id = again.body.feed.id;
    const del = (who: string, fid: number) => call(feedOneRoute.DELETE, req(`/calendar/feeds/${fid}`, P[who].session, undefined, "DELETE"), { id: String(fid) });
    assert.equal((await del("agent2", id)).status, 404, "another agent cannot revoke it (or learn that it exists)");
    assert.equal((await del("agent", 2147483000)).status, 404);
    assert.equal((await del("dadmin", id)).status, 200);
    assert.equal((await fetchFeed(tokenOf(teamUrl))).status, 404);
    const audit = (await pool().query("SELECT action, details FROM audit_log WHERE action LIKE 'helpdesk.calendar_feed.%' AND target_id = $1 ORDER BY id", [id])).rows;
    assert.deepEqual(audit.map((a) => [a.action, a.details.by_owner ?? null]), [["helpdesk.calendar_feed.regenerated", null], ["helpdesk.calendar_feed.revoked", false]]);
  });

  test("a feed shows what its owner may see when it is fetched: 'all my teams', then nothing once they leave the team or the desk", async () => {
    const all = await makeFeed("agent2", null);
    const team = await makeFeed("agent2", T.A);
    const mineInB = await ticket("Feed assigned in B", "B", "open", { assignee: P.agent2.id });
    await putEvent("other", mineInB.number, soon(5));
    let body = (await fetchFeed(tokenOf(all.body.url))).text;
    assert.match(body, /X-WR-CALNAME:Helpdesk events/);
    assert.ok(body.includes(`#${mineInB.number} `), "their own ticket in another team is in 'all my teams'");
    assert.ok(!(await fetchFeed(tokenOf(team.body.url))).text.includes(`#${mineInB.number} `));
    // Settings admins see everyone's links, never a token.
    const everyone = await call(feedsRoute.GET, req("/calendar/feeds?all=1", P.dadmin.session));
    assert.equal(everyone.status, 200);
    assert.ok(everyone.body.feeds.some((f: { owner_name: string; team_name: string | null; mine: boolean }) => f.owner_name === P.agent2.name && f.team_name === null && !f.mine));
    assert.ok(!JSON.stringify(everyone.body).includes(tokenOf(all.body.url).slice(4, 30)));
    assert.equal((await call(feedsRoute.GET, req("/calendar/feeds?all=1", P.agent.session))).status, 403);
    // Off the team: the team link dies, "all my teams" shrinks to their own tickets.
    await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T.A, P.agent2.id]);
    try {
      assert.equal((await fetchFeed(tokenOf(team.body.url))).status, 404);
      body = (await fetchFeed(tokenOf(all.body.url))).text;
      assert.ok(body.includes(`#${mineInB.number} `) && !/Room 30/.test(body));
      // Off the desk altogether: nothing, the same 404.
      await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.agent2.id]);
      assert.deepEqual([(await fetchFeed(tokenOf(all.body.url))).status, (await fetchFeed(tokenOf(all.body.url))).text], [404, "Not found.\n"]);
      await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent')", [P.agent2.id]);
      await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [P.agent2.id]);
      assert.equal((await fetchFeed(tokenOf(all.body.url))).status, 404, "a disabled account's links stop");
    } finally {
      await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [P.agent2.id]);
      await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent') ON CONFLICT (user_id) DO NOTHING", [P.agent2.id]);
      await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent') ON CONFLICT DO NOTHING", [T.A, P.agent2.id]);
    }
  });

  test("rate limits: a link is read at most 30 times a minute, and misses from one address are counted", async () => {
    const made = await makeFeed("lead", T.A);
    const t = tokenOf(made.body.url);
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await fetchFeed(t, "198.51.100.20")).status);
    assert.deepEqual([statuses.slice(0, 30).every((s) => s === 200), statuses[30], statuses[31]], [true, 429, 429]);
    const misses: number[] = [];
    for (let i = 0; i < 32; i++) misses.push((await fetchFeed(`cdf_${String(i).padStart(43, "B")}.ics`, "198.51.100.21")).status);
    assert.deepEqual([misses.slice(0, 30).every((s) => s === 404), misses[31]], [true, 429]);
    assert.equal((await fetchFeed(`cdf_${"C".repeat(43)}.ics`, "198.51.100.22")).status, 404, "another address is not held back by it");
  });
});

// =======================================================================================

describe("the API, webhooks and the Claude connector", () => {
  test("REST: event on GET and PATCH; set, change, mark and remove; the solve refusal and event.setup_complete in the same PATCH; the webhooks", async () => {
    const hook = await pool().query(
      "INSERT INTO hd_webhooks (name, url, events, team_ids, secret_sealed) VALUES ($1, 'https://hooks.example.test/x', '{ticket.updated,ticket.solved,event.setup_completed}', $2, 'sealed') RETURNING id",
      [`${STAMP} hook`, [T.A]]
    );
    hookIds.push(hook.rows[0].id);
    const made = await call(tokensRoute.POST, new Request("http://localhost/api/helpdesk/admin/api/tokens", {
      method: "POST",
      headers: { cookie: `compass_session=${P.dadmin.session}`, "content-type": "application/json" },
      body: JSON.stringify({ name: `${STAMP} sync`, role: "agent", team_ids: [T.A], expires_at: null }),
    }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokenIds.push(made.body.view.id);
    userIds.push((await pool().query("SELECT principal_id FROM hd_api_tokens WHERE id = $1", [made.body.view.id])).rows[0].principal_id);
    const api = (handler: unknown, url: string, method: string, body?: unknown, params: Record<string, string> = {}) =>
      call(handler, new Request(`http://localhost/api/helpdesk/v1${url}`, { method, headers: { authorization: `Bearer ${made.body.token}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.78" }, body: body === undefined ? undefined : JSON.stringify(body) }), params);
    const t = await ticket("API event");
    const p = { number: String(t.number) };
    assert.equal((await api(v1TicketRoute.GET, `/tickets/${t.number}`, "GET", undefined, p)).body.event, null, "always present, null when there is none");
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { event: { starts_at: "tomorrow" } }, p)).status, 400);
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { event: { colour: "red" } }, p)).status, 400);
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { event: { setup_complete: true } }, p)).status, 404, "no event to mark");
    const set = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { event: { starts_at: "2031-05-06T10:00:00+02:00", ends_at: "2031-05-06T11:00:00+02:00", place: "Lobby", setup_minutes: 15 } }, p);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.changed, ["event"]);
    assert.deepEqual(set.body.ticket.event, { starts_at: "2031-05-06T08:00:00.000Z", ends_at: "2031-05-06T09:00:00.000Z", all_day: false, timezone: TZ, place: "Lobby", setup_minutes: 15, ready_by: "2031-05-06T07:45:00.000Z", setup_complete: false, setup_completed_at: null, setup_completed_by: null, cancelled: false });
    assert.ok((await lines(t.id)).some((l) => /added an event: .* via API$/.test(l.body)));
    assert.equal((await api(v1TicketRoute.GET, `/tickets/${t.number}`, "GET", undefined, p)).body.event.place, "Lobby");
    // Solving is refused with the code and what is missing; with the mark in the same PATCH it goes through.
    const refused = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { status: "solved" }, p);
    assert.deepEqual([refused.status, refused.body.code, refused.body.error, refused.body.missing], [409, "solve_requirements", NEEDS, [{ kind: "event_setup", key: "setup_complete", label: "The event setup marked complete" }]]);
    const reply = await api(v1RepliesRoute.POST, `/tickets/${t.number}/replies`, "POST", { body: "Done.", status: "solved" }, p);
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public'", [t.id])).rows[0].n, 0, "the reply was not sent");
    const ok = await api(v1TicketRoute.PATCH, `/tickets/${t.number}`, "PATCH", { status: "solved", event: { setup_complete: true } }, p);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.ticket.status, ok.body.ticket.event.setup_complete, ok.body.ticket.event.setup_completed_by, ok.body.changed], ["solved", true, `${STAMP} sync`, ["status", "event"]]);
    // A whole-day event and removing one, on another ticket.
    const t2 = await ticket("API event two");
    const p2 = { number: String(t2.number) };
    const day = await api(v1TicketRoute.PATCH, `/tickets/${t2.number}`, "PATCH", { event: { all_day: true, start_date: "2031-05-06", end_date: "2031-05-07", timezone: "Asia/Tokyo" } }, p2);
    assert.deepEqual([day.body.ticket.event.all_day, day.body.ticket.event.start_date, day.body.ticket.event.end_date, day.body.ticket.event.starts_at], [true, "2031-05-06", "2031-05-07", "2031-05-05T15:00:00.000Z"]);
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${t2.number}`, "PATCH", { event: { setup_complete: true } }, p2)).body.ticket.event.setup_complete, true);
    const gone = await api(v1TicketRoute.PATCH, `/tickets/${t2.number}`, "PATCH", { event: null }, p2);
    assert.deepEqual([gone.status, gone.body.ticket.event, gone.body.changed], [200, null, ["event"]]);
    // A ticket of another team is not the token's to touch.
    const foreign = await ticket("API foreign", "B");
    assert.equal((await api(v1TicketRoute.PATCH, `/tickets/${foreign.number}`, "PATCH", { event: { starts_at: "2031-05-06T10:00:00Z" } }, { number: String(foreign.number) })).status, 404);

    // Webhooks: ticket.event on every ticket payload; ticket.updated for an event change; event.setup_completed once marked.
    const rows = (await pool().query("SELECT event, payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 ORDER BY id", [hook.rows[0].id, t.id])).rows;
    const events = rows.map((r) => r.event);
    assert.deepEqual(events.filter((e) => e === "event.setup_completed").length, 1, JSON.stringify(events));
    const first = rows.find((r) => r.event === "ticket.updated")!;
    assert.deepEqual([first.payload.changes, first.payload.ticket.event.place, first.payload.ticket.event.setup_complete], [["event"], "Lobby", false]);
    const done = rows.find((r) => r.event === "event.setup_completed")!;
    assert.deepEqual([done.payload.ticket.number, done.payload.ticket.event.setup_complete, done.payload.actor.name], [t.number, true, `${STAMP} sync`]);
    assert.equal(rows.find((r) => r.event === "ticket.solved")!.payload.ticket.event.setup_complete, true);
    const plain = await ticket("Hook plain");
    await patch("agent", plain.number, { status: "solved" });
    assert.equal((await pool().query("SELECT payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 AND event = 'ticket.solved'", [hook.rows[0].id, plain.id])).rows[0].payload.ticket.event, null);
    assert.ok(apiShared.HD_WEBHOOK_EVENTS.includes("event.setup_completed") && apiShared.HD_WEBHOOK_EVENT_HINT["event.setup_completed"]);
  });

  test("the Claude connector: hd_read_ticket shows the event and what a solve needs; hd_update_ticket sets it, is refused on solve, and marks setup", async () => {
    claude.setClaudeLevelForTests("update");
    const t = await ticket("Connector event");
    const user = (await getUserById(P.agent.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await hdTools.callHelpdeskTool(user, name, args, ctx);
      return { isError: r.isError, text: r.content[0].text as string };
    };
    assert.equal(JSON.parse((await tool("hd_read_ticket", { number: t.number })).text).event, null);
    const set = await tool("hd_update_ticket", { number: t.number, event: { starts_at: "2031-05-08T09:00:00Z", place: "Studio", setup_minutes: 60 } });
    assert.equal(set.isError, false, set.text);
    const out = JSON.parse(set.text);
    assert.deepEqual([out.changed, out.event.place, out.event.ends_at], [["event"], "Studio", "2031-05-08T10:00:00.000Z"]);
    assert.ok((await lines(t.id)).some((l) => /added an event: .* via Claude$/.test(l.body)));
    const read = JSON.parse((await tool("hd_read_ticket", { number: t.number })).text);
    assert.deepEqual([read.event.setup_complete, read.before_you_solve.needed_now, read.before_you_solve.event_setup_complete], [false, NEEDS, false]);
    const refused = await tool("hd_update_ticket", { number: t.number, status: "solved" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^Before you solve, this ticket needs: the event setup marked complete\. \(409\).*event: \{ setup_complete: true \}/);
    assert.equal((await tool("hd_update_ticket", { number: t.number, event: { nope: 1 } })).isError, true);
    const ok = await tool("hd_update_ticket", { number: t.number, status: "solved", event: { setup_complete: true } });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(await statusOf(t.id), "solved");
    assert.equal(JSON.parse((await tool("hd_read_ticket", { number: t.number })).text).before_you_solve, undefined);
    const reqUser = (await getUserById(P.req.id))!;
    const asRequester = await hdTools.callHelpdeskTool(reqUser, "hd_read_request", { number: t.number }, ctx);
    assert.ok(!/Studio|setup_complete/.test(asRequester.content[0].text), "the requester's read has none of it");
    const def = hdTools.HELPDESK_TOOL_DEFS.find((x) => x.name === "hd_update_ticket") as unknown as { inputSchema: { properties: Record<string, unknown> } };
    assert.ok(def.inputSchema.properties.event);
  });
});

describe("upgrade", () => {
  test("the schema is additive and can be applied again and again; nothing is switched on by it", async () => {
    const sql = db.guardCreateIndexes(db.guardAddColumns(schema.HD_DESK_CALENDAR_SCHEMA));
    assert.ok(!/\bDROP\b|\bTRUNCATE\b|DELETE FROM|ALTER TABLE \w+ (?!ADD COLUMN IF NOT EXISTS)/i.test(schema.HD_DESK_CALENDAR_SCHEMA), "only CREATE … IF NOT EXISTS and ADD COLUMN IF NOT EXISTS");
    await pool().query(sql);
    await pool().query(sql);
    const col = (await pool().query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'hd_request_types' AND column_name = 'calendar'")).rows[0];
    assert.deepEqual([col.is_nullable, /'\{\}'/.test(col.column_default)], ["NO", true], "existing request types read as off");
    assert.deepEqual(shared.resolveRequestTypeCalendar({}), { enabled: false, start_field: "", end_field: "", place_field: "", lead_minutes: 30 });
    assert.deepEqual(shared.resolveCalendarPrefs(null), { view: "week", team_id: 0, colour: "team", layers: [] });
  });
});

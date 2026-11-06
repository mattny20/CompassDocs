// Helpdesk 1.19.0 (calendars, agent L): business calendars, holidays and
// per-team reply targets through the admin routes (route handlers called
// directly, as in test/helpdesk-core.test.ts: next/headers resolves to a
// stub serving the request under test, lib/ee to a stub that grants
// "helpdesk"). Team resolution and the default-calendar fallback; transfer
// keeping elapsed business minutes (to a stricter team: breached at the
// move; to a looser one: the rest of its target); re-timing after a
// holiday is added and after a team's targets change; reset; .ics import,
// paste and copy-to-next-year; the preview; the gates; the audit rows.
//
// Parallel-safe: every calendar, holiday set, team and ticket here is this
// file's own (stamped names). The default calendar and the workspace
// policies are never edited (the starter SLA rows are inserted if missing,
// insert-only). Nobody is a workspace admin: the configurer holds
// helpdesk.admin through a role on a plain viewer.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-calendars.test.ts


import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pool, getSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-calendars.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-calendars.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
/** lib/ee as a licensed enterprise build sees it; the licence test empties `features`. */
const edition = { present: true, features: ["helpdesk"] as string[] };
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
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
    if (request === "../ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "..", "ee") === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

type AnyHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; res: Response }> {
  currentRequest = req;
  try {
    const res = await (handler as AnyHandler)(req, { params: Promise.resolve(params) });
    let body: any = null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      try {
        body = await res.clone().json();
      } catch {
        /* none */
      }
    }
    return { status: res.status, body, res };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.78" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdcal-${Date.now()}-${randomBytes(3).toString("hex")}`;
const PEOPLE = ["configurer", "agent", "requester"] as const;
const P: Record<string, { id: number; session: string }> = {};
const s = (k: (typeof PEOPLE)[number]) => P[k].session;
const ids = { teamA: 0, teamB: 0, teamC: 0, roleAdmin: 0 };
const calendarIds: number[] = [];
const setIds: number[] = [];

const routes = {
  calendars: () => import("../src/app/api/helpdesk/admin/calendars/route"),
  calendar: () => import("../src/app/api/helpdesk/admin/calendars/[id]/route"),
  assign: () => import("../src/app/api/helpdesk/admin/calendars/assign/route"),
  preview: () => import("../src/app/api/helpdesk/admin/calendars/preview/route"),
  teamSla: () => import("../src/app/api/helpdesk/admin/calendars/teams/[teamId]/sla/route"),
  sets: () => import("../src/app/api/helpdesk/admin/holiday-sets/route"),
  set: () => import("../src/app/api/helpdesk/admin/holiday-sets/[id]/route"),
  holidays: () => import("../src/app/api/helpdesk/admin/holiday-sets/[id]/holidays/route"),
  holiday: () => import("../src/app/api/helpdesk/admin/holiday-sets/[id]/holidays/[holidayId]/route"),
  importIcs: () => import("../src/app/api/helpdesk/admin/holiday-sets/[id]/import/route"),
  copyYear: () => import("../src/app/api/helpdesk/admin/holiday-sets/[id]/copy-year/route"),
};
const lib = () => import("../src/lib/helpdesk/calendars");

const WEEKDAYS = (start: string, end: string) => [[], [{ start, end }], [{ start, end }], [{ start, end }], [{ start, end }], [{ start, end }], []];

async function auditRows(action: string): Promise<{ target_id: string; target_label: string; details: any }[]> {
  return (
    await pool().query("SELECT target_id, target_label, details FROM audit_log WHERE actor_id = $1 AND action = $2 ORDER BY id", [P.configurer.id, action])
  ).rows;
}

async function insertTicket(teamId: number, fields: Record<string, unknown>): Promise<number> {
  const all: Record<string, unknown> = { subject: `${STAMP} ticket`, requester_id: P.requester.id, requester_name: "Req", requester_email: "req@example.test", team_id: teamId, status: "open", priority: "normal", ...fields };
  const cols = Object.keys(all);
  const vals = Object.values(all);
  const r = await fixtureQuery(`INSERT INTO hd_tickets (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, vals);
  return r.rows[0].id;
}

async function ticketDues(id: number): Promise<{ first_reply_due: string | null; resolve_due: string | null }> {
  const r = (await pool().query("SELECT first_reply_due, resolve_due FROM hd_tickets WHERE id = $1", [id])).rows[0];
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return { first_reply_due: iso(r.first_reply_due), resolve_due: iso(r.resolve_due) };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const creds = hashPassword("Helpdesk!Cal123");
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const k of PEOPLE) {
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt)
       VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, `Cal ${k}`, `${STAMP}-${k}@example.test`, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    P[k] = { id: r.rows[0].id, session };
  }
  const adm = await fixtureQuery("INSERT INTO roles (key, name, description) VALUES ($1, $2, '') RETURNING id", [`${STAMP}-admin`, `${STAMP} configure`]);
  ids.roleAdmin = adm.rows[0].id;
  await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.admin')", [ids.roleAdmin]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [ids.roleAdmin, P.configurer.id]);
  const agentRole = (await pool().query("SELECT id FROM roles WHERE key = 'helpdesk-agent'")).rows[0].id;
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [agentRole, P.agent.id]);
  for (const k of ["teamA", "teamB", "teamC"] as const) {
    ids[k] = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} ${k}`])).rows[0].id;
  }
  await pool().query("INSERT INTO hd_team_members (team_id, user_id) VALUES ($1, $2)", [ids.teamA, P.agent.id]);
  const { ensureStarterPolicies } = await import("../src/lib/helpdesk/db-sla");
  await ensureStarterPolicies();
  await (await lib()).calendarsReady();
});

after(async () => {
  const userIds = PEOPLE.map((k) => P[k]?.id).filter(Boolean);
  const teams = [ids.teamA, ids.teamB, ids.teamC];
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2)", [teams, userIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teams]);
  await pool().query("DELETE FROM hd_calendars WHERE name LIKE $1 AND is_default = 0", [`${STAMP}%`]);
  await pool().query("DELETE FROM hd_holiday_sets WHERE name LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = $1", [ids.roleAdmin]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  (await lib()).invalidateCalendarCache();
});

// --- Tests ---------------------------------------------------------------------------

describe("gates", () => {
  test("only sla.manage configures calendars; unlicensed is 402", async () => {
    const { GET } = await routes.calendars();
    assert.equal((await call(GET, req("/api/helpdesk/admin/calendars", s("agent")))).status, 403);
    assert.equal((await call(GET, req("/api/helpdesk/admin/calendars", s("requester")))).status, 403);
    const { POST } = await routes.preview();
    assert.equal((await call(POST, req("/api/helpdesk/admin/calendars/preview", s("agent"), { start: new Date().toISOString(), minutes: 60 }))).status, 403);
    edition.features = [];
    try {
      assert.equal((await call(GET, req("/api/helpdesk/admin/calendars", s("configurer")))).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
    const ok = await call(GET, req("/api/helpdesk/admin/calendars", s("configurer")));
    assert.equal(ok.status, 200);
    assert.ok(ok.body.default_id, "a default calendar exists (migrated from the settings)");
    const def = ok.body.calendars.find((c: any) => c.is_default);
    assert.ok(def.summary.length > 0);
  });
});

describe("calendars, teams and resolution", () => {
  let calA = 0;
  let calB = 0;
  let setId = 0;

  test("create calendars and a holiday set; bad input is refused", async () => {
    const { POST } = await routes.calendars();
    const bad = await call(POST, req("/api/helpdesk/admin/calendars", s("configurer"), { name: `${STAMP} bad`, timezone: "Mars/Olympus", schedule: WEEKDAYS("09:00", "17:00") }));
    assert.equal(bad.status, 400);
    const overlap = await call(POST, req("/api/helpdesk/admin/calendars", s("configurer"), {
      name: `${STAMP} bad`,
      timezone: "Europe/London",
      schedule: [[], [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "17:00" }], [], [], [], [], []],
    }));
    assert.equal(overlap.status, 400);
    const a = await call(POST, req("/api/helpdesk/admin/calendars", s("configurer"), { name: `${STAMP} London`, timezone: "Europe/London", schedule: WEEKDAYS("09:00", "17:00") }));
    assert.equal(a.status, 201);
    assert.equal(a.body.calendar.summary, "Mon–Fri 09:00–17:00");
    calA = a.body.calendar.id;
    calendarIds.push(calA);
    const b = await call(POST, req("/api/helpdesk/admin/calendars", s("configurer"), { name: `${STAMP} New York`, timezone: "America/New_York", schedule: WEEKDAYS("09:00", "17:00") }));
    calB = b.body.calendar.id;
    calendarIds.push(calB);
    const dup = await call(POST, req("/api/helpdesk/admin/calendars", s("configurer"), { name: `${STAMP} London`, timezone: "Europe/London", schedule: WEEKDAYS("09:00", "17:00") }));
    assert.equal(dup.status, 409);

    const sets = await routes.sets();
    const set = await call(sets.POST, req("/api/helpdesk/admin/holiday-sets", s("configurer"), { name: `${STAMP} UK`, text: "2020-12-25 Christmas Day (yearly)\n2026-12-28 Boxing Day (substitute)" }));
    assert.equal(set.status, 201);
    assert.equal(set.body.holiday_set.holidays.length, 2);
    setId = set.body.holiday_set.id;
    setIds.push(setId);
    const { PATCH } = await routes.calendar();
    const linked = await call(PATCH, req(`/api/helpdesk/admin/calendars/${calA}`, s("configurer"), { holiday_set_ids: [setId] }, "PATCH"), { id: String(calA) });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.calendar.holiday_set_ids, [setId]);

    const created = await auditRows("helpdesk.calendar.created");
    assert.ok(created.some((r) => Number(r.target_id) === calA && r.target_label === `${STAMP} London`));
    assert.ok((await auditRows("helpdesk.calendar.updated")).some((r) => Number(r.target_id) === calA && r.details.changed.includes("holiday_sets")));
    assert.ok((await auditRows("helpdesk.holiday_set.created")).some((r) => Number(r.target_id) === setId));
  });

  test("teams resolve to their calendar; no calendar (or no team) means the default", async () => {
    const { PATCH } = await routes.assign();
    const r = await call(PATCH, req("/api/helpdesk/admin/calendars/assign", s("configurer"), { team_id: ids.teamA, calendar_id: calA }, "PATCH"));
    assert.equal(r.status, 200);
    await call(PATCH, req("/api/helpdesk/admin/calendars/assign", s("configurer"), { team_id: ids.teamB, calendar_id: calB }, "PATCH"));
    assert.equal((await call(PATCH, req("/api/helpdesk/admin/calendars/assign", s("configurer"), { team_id: ids.teamA, calendar_id: 2 ** 30 }, "PATCH"))).status, 404);
    const L = await lib();
    const snap = await L.calendarSnapshot();
    assert.equal((await L.hoursForTeam(ids.teamA)).calendar?.id, calA);
    assert.equal((await L.hoursForTicket({ team_id: ids.teamB })).timezone, "America/New_York");
    assert.equal((await L.hoursForTeam(ids.teamC)).calendar?.id, snap.defaultId);
    assert.equal((await L.hoursForTeam(null)).calendar?.id, snap.defaultId);
    const changed = await auditRows("helpdesk.team.calendar_changed");
    assert.ok(changed.some((x) => Number(x.target_id) === ids.teamA && x.details.to.id === calA && x.details.from.id === null));
    // Christmas (yearly) closes team A every year.
    const st = await L.teamOpenState(ids.teamA, Date.parse("2027-12-25T12:00:00Z"));
    assert.equal(st.open, false);
    assert.equal(st.holidayName, "Christmas Day");
    assert.match(st.message, /^The .+ team is closed for Christmas Day\. We'll reply from Mon 09:00\.$/);
    assert.equal(await L.businessMinutesForTicket({ team_id: ids.teamA }, Date.parse("2026-11-09T08:00:00Z"), Date.parse("2026-11-10T08:00:00Z")), 480);
    assert.equal((await L.addTeamBusinessMinutes(ids.teamB, Date.parse("2026-11-09T12:00:00Z"), 60)).toISOString(), "2026-11-09T15:00:00.000Z");
  });

  test("team targets: override, the source in the tooltip, reset", async () => {
    const { PUT, GET } = await routes.teamSla();
    const url = `/api/helpdesk/admin/calendars/teams/${ids.teamA}/sla`;
    assert.equal((await call(PUT, req(url, s("agent"), { targets: null }, "PUT"), { teamId: String(ids.teamA) })).status, 403);
    assert.equal((await call(PUT, req(url, s("configurer"), { targets: [{ priority: "normal", first_reply_minutes: 0, resolve_minutes: 10 }] }, "PUT"), { teamId: String(ids.teamA) })).status, 400);
    const put = await call(PUT, req(url, s("configurer"), { targets: [{ priority: "normal", first_reply_minutes: 240, resolve_minutes: 960, business_hours: 1 }] }, "PUT"), { teamId: String(ids.teamA) });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.view.targets, [{ priority: "normal", first_reply_minutes: 240, resolve_minutes: 960, business_hours: 1 }]);
    const view = await call(GET, req(url, s("configurer")), { teamId: String(ids.teamA) });
    assert.ok(view.body.workspace.some((w: any) => w.priority === "normal"));
    const L = await lib();
    const pol = await L.slaPolicyForTeam("normal", ids.teamA);
    assert.equal(pol?.source, "team");
    assert.equal(pol?.first_reply_minutes, 240);
    assert.ok(pol?.policy_id, "the workspace row stays the ticket's sla_policy_id");
    assert.equal((await L.slaPolicyForTicket({ priority: "high", team_id: ids.teamA }))?.source, "workspace");
    assert.equal((await L.slaPolicyForTeam("normal", ids.teamC))?.source, "workspace");
    assert.match(await L.slaTargetNote({ team_id: ids.teamA, priority: "normal", first_replied_at: null }), / team target: first reply in 4 business hours$/);
    assert.ok((await auditRows("helpdesk.team.sla_updated")).some((r) => Number(r.target_id) === ids.teamA && r.details.after[0].first_reply_minutes === 240));
  });

  test("transfer keeps the business minutes used, measured in the old calendar", async () => {
    const L = await lib();
    // Team B (New York) gets a stricter target (2h) and team C (default calendar) none.
    const put = await call(
      (await routes.teamSla()).PUT,
      req(`/api/helpdesk/admin/calendars/teams/${ids.teamB}/sla`, s("configurer"), { targets: [{ priority: "normal", first_reply_minutes: 120, resolve_minutes: 480 }] }, "PUT"),
      { teamId: String(ids.teamB) }
    );
    assert.equal(put.status, 200);
    // Created Mon 9 Nov 2026 10:00 GMT in team A (London 09–17, first reply 4h → 14:00Z, resolve 16h).
    const created = "2026-11-09T10:00:00.000Z";
    const hoursA = await L.hoursForTeam(ids.teamA);
    const { addBusinessMinutes } = await import("../src/lib/helpdesk/sla");
    const row = {
      id: 0,
      team_id: ids.teamA,
      priority: "normal" as const,
      status: "open" as const,
      created_at: created,
      first_reply_due: addBusinessMinutes(Date.parse(created), 240, hoursA).toISOString(),
      resolve_due: addBusinessMinutes(Date.parse(created), 960, hoursA).toISOString(),
      first_replied_at: null,
      sla_paused_at: null,
      sla_paused_ms: 0,
      sla_policy_id: null,
    };
    assert.equal(row.first_reply_due, "2026-11-09T14:00:00.000Z");
    const now = Date.parse("2026-11-09T12:00:00Z"); // 2h of the 4h used
    // Stricter: 2h used of team B's 2h → breached at the move.
    const strict = await L.transferDues(row, ids.teamA, ids.teamB, now);
    assert.equal(strict.first_reply_due?.toISOString(), "2026-11-09T12:00:00.000Z");
    assert.equal(strict.breached.first_reply, true);
    // Resolve: 2h used of B's 8h → 6h in New York from Mon 09:00 EST (14:00Z) → 20:00Z.
    assert.equal(strict.resolve_due?.toISOString(), "2026-11-09T20:00:00.000Z");
    assert.equal(strict.breached.resolve, false);
    assert.equal(strict.policy_source, "team");
    // Looser: team C uses the workspace's normal target (whatever it is): 2h used, the rest in the default calendar.
    const ws = (await L.slaPolicyForTeam("normal", ids.teamC))!;
    const hoursC = await L.hoursForTeam(ids.teamC);
    const loose = await L.transferDues(row, ids.teamA, ids.teamC, now);
    const leftFirst = ws.first_reply_minutes - 120;
    if (leftFirst > 0) {
      assert.equal(loose.first_reply_due?.toISOString(), addBusinessMinutes(now, leftFirst, hoursC).toISOString());
      assert.equal(loose.breached.first_reply, false);
    }
    assert.equal(loose.policy_source, "workspace");
    // Back the same way: nothing used up, met clocks and past dues stay put.
    const met = await L.transferDues({ ...row, first_replied_at: "2026-11-09T11:00:00Z" }, ids.teamA, ids.teamB, now);
    assert.equal(met.first_reply_due?.toISOString(), row.first_reply_due);
    const late = await L.transferDues(row, ids.teamA, ids.teamB, Date.parse("2026-11-09T15:00:00Z"));
    assert.equal(late.first_reply_due?.toISOString(), row.first_reply_due, "a breach that already happened is not undone");
    assert.equal(late.breached.first_reply, false);
    // Paused: measured to the pause, the rest counted from the pause.
    const paused = await L.transferDues({ ...row, status: "pending", sla_paused_at: "2026-11-09T11:00:00.000Z" }, ids.teamA, ids.teamB, now);
    // 1h used of B's 2h → 1h from 11:00Z in New York (opens 14:00Z) → 15:00Z.
    assert.equal(paused.first_reply_due?.toISOString(), "2026-11-09T15:00:00.000Z");
  });

  test("a move that uses the target up leaves the due at the move for the SLA sweep to stamp", async () => {
    // Team B's 2h first-reply target is set by the previous test. In team A
    // (4h) with a minute left, ~4h are used: moving to B breaches at the move.
    const { updateTicket } = await import("../src/lib/helpdesk/tickets");
    const { claimSlaEvents } = await import("../src/lib/helpdesk/db-sla");
    const now = Date.now();
    const id = await insertTicket(ids.teamA, {
      created_at: new Date(now - 86_400_000),
      first_reply_due: new Date(now + 60_000),
      resolve_due: new Date(now + 30 * 86_400_000),
    });
    const res = await updateTicket(id, { team_id: ids.teamB }, { id: P.configurer.id, name: "Configurer" });
    assert.ok(res);
    const row = (await pool().query("SELECT first_reply_due, first_reply_breached_at FROM hd_tickets WHERE id = $1", [id])).rows[0];
    assert.equal(row.first_reply_breached_at, null, "the move does not stamp the breach itself (that would suppress the notice)");
    const due = new Date(row.first_reply_due).getTime();
    assert.ok(due >= now && due <= Date.now(), "the due is the move");
    let swept;
    for (let i = 0; i < 20; i++) {
      swept = await claimSlaEvents(new Date(), [id]);
      if (swept.ran) break;
      await new Promise((r) => setTimeout(r, 100)); // another process holds the sweep lock
    }
    assert.ok(swept!.ran);
    assert.deepEqual(swept!.events.filter((e) => e.kind === "breach"), [{ ticket_id: id, kind: "breach", target: "first_reply" }]);
    const after = (await pool().query("SELECT first_reply_breached_at FROM hd_tickets WHERE id = $1", [id])).rows[0];
    assert.ok(after.first_reply_breached_at, "the sweep stamps it");
  });

  test("a priority change keeps the business time used, never the wall-clock time paused", async () => {
    // Team B (New York, 09–17 weekdays) gets the same 2h/8h target for normal and high.
    const put = await call(
      (await routes.teamSla()).PUT,
      req(
        `/api/helpdesk/admin/calendars/teams/${ids.teamB}/sla`,
        s("configurer"),
        { targets: [{ priority: "normal", first_reply_minutes: 120, resolve_minutes: 480 }, { priority: "high", first_reply_minutes: 120, resolve_minutes: 480 }] },
        "PUT"
      ),
      { teamId: String(ids.teamB) }
    );
    assert.equal(put.status, 200);
    const L = await lib();
    // Created Mon 10:00 NY (15:00Z); paused Mon 15:00 → Tue 10:00 NY: 19h on the
    // wall, 3 business hours. Resolve: 8h + 3h paused → due Tue 13:00 NY (18:00Z).
    const row = {
      id: 0,
      team_id: ids.teamB,
      priority: "normal" as const,
      status: "open" as const,
      created_at: "2026-11-09T15:00:00.000Z",
      first_reply_due: "2026-11-09T17:00:00.000Z",
      resolve_due: "2026-11-10T18:00:00.000Z",
      first_replied_at: "2026-11-09T16:00:00.000Z",
      sla_paused_at: null,
      sla_paused_ms: 19 * 3_600_000,
      sla_policy_id: null,
    };
    const now = Date.parse("2026-11-10T16:00:00Z"); // Tue 11:00 NY: 6 of the 8 hours used
    const same = await L.reprioritisedDues(row, { team: ids.teamB, priority: "normal" }, { team: ids.teamB, priority: "high" }, now);
    assert.equal(same.resolve_due, "2026-11-10T18:00:00.000Z", "same target: the due does not move (wall-clock pause would give 22:00Z)");
    assert.equal(same.first_reply_due, row.first_reply_due, "a met first reply keeps its due");
    // To urgent (the workspace's, whatever it is): the rest of its target from now, or due now when used up.
    const urgent = (await L.slaPolicyForTeam("urgent", ids.teamB))!;
    const strict = await L.reprioritisedDues(row, { team: ids.teamB, priority: "normal" }, { team: ids.teamB, priority: "urgent" }, now);
    const left = urgent.resolve_minutes - 360;
    if (left <= 0) assert.equal(strict.resolve_due, new Date(now).toISOString());
    else assert.ok(Date.parse(strict.resolve_due!) > now);
    // Paused: measured to where the clock stopped.
    const paused = await L.reprioritisedDues({ ...row, status: "pending", sla_paused_at: "2026-11-10T16:00:00.000Z" }, { team: ids.teamB, priority: "normal" }, { team: ids.teamB, priority: "high" }, Date.parse("2026-11-11T16:00:00Z"));
    assert.equal(paused.resolve_due, "2026-11-10T18:00:00.000Z");
    // Through updateTicket: a same-target change leaves the dues where they were.
    const { updateTicket } = await import("../src/lib/helpdesk/tickets");
    const { addBusinessMinutes } = await import("../src/lib/helpdesk/sla");
    // 2 of the 8 business hours left (a due further out than the target allows would be clamped).
    const due = addBusinessMinutes(Date.now(), 120, await L.hoursForTeam(ids.teamB));
    const id = await insertTicket(ids.teamB, { created_at: new Date(Date.now() - 86_400_000), resolve_due: due, first_reply_due: due, sla_paused_ms: 10 * 3_600_000 });
    await updateTicket(id, { priority: "high" }, { id: P.configurer.id, name: "Configurer" });
    const after = await ticketDues(id);
    assert.ok(Math.abs(Date.parse(after.resolve_due!) - due.getTime()) < 60_000, `resolve due kept: ${after.resolve_due} vs ${due.toISOString()}`);
  });

  test("adding a holiday re-times the open, running tickets of the calendar's teams", async () => {
    const L = await lib();
    const now = Date.now();
    const hoursA = await L.hoursForTeam(ids.teamA);
    const { addBusinessMinutes, businessMinutesBetween } = await import("../src/lib/helpdesk/sla");
    const due = addBusinessMinutes(now, 240, hoursA);
    const resolve = addBusinessMinutes(now, 960, hoursA);
    const running = await insertTicket(ids.teamA, { created_at: new Date(now), first_reply_due: due, resolve_due: resolve });
    const paused = await insertTicket(ids.teamA, { status: "pending", sla_paused_at: new Date(now), created_at: new Date(now), first_reply_due: due, resolve_due: resolve });
    const other = await insertTicket(ids.teamB, { created_at: new Date(now), first_reply_due: due, resolve_due: resolve });
    // Close the day the first reply falls due (in London).
    const dueDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(due);
    const { POST } = await routes.holidays();
    const r = await call(POST, req(`/api/helpdesk/admin/holiday-sets/${setIds[0]}/holidays`, s("configurer"), { holidays: [{ date: dueDay, name: `${STAMP} closure` }] }), { id: String(setIds[0]) });
    assert.equal(r.status, 200);
    assert.equal(r.body.added.length, 1);
    assert.ok(r.body.retimed >= 1);
    const after = await L.hoursForTeam(ids.teamA);
    const moved = await ticketDues(running);
    const expect = addBusinessMinutes(now, 240, after).getTime();
    assert.ok(Math.abs(Date.parse(moved.first_reply_due!) - expect) < 120_000, `${moved.first_reply_due} ≈ ${new Date(expect).toISOString()}`);
    assert.ok(Date.parse(moved.first_reply_due!) > due.getTime());
    assert.ok(businessMinutesBetween(now, Date.parse(moved.first_reply_due!), after) > 235);
    assert.equal((await ticketDues(paused)).first_reply_due, due.toISOString(), "paused tickets wait for resume");
    assert.equal((await ticketDues(other)).first_reply_due, due.toISOString(), "other calendars' teams are untouched");
    const upd = await auditRows("helpdesk.holiday_set.updated");
    assert.ok(upd.some((x) => Number(x.target_id) === setIds[0] && x.details.added_count === 1));
    // Removing it again brings the due back.
    const hid = r.body.added[0].id;
    const del = await call((await routes.holiday()).DELETE, req(`/api/helpdesk/admin/holiday-sets/${setIds[0]}/holidays/${hid}`, s("configurer"), undefined, "DELETE"), {
      id: String(setIds[0]),
      holidayId: String(hid),
    });
    assert.equal(del.status, 200);
    assert.ok(Math.abs(Date.parse((await ticketDues(running)).first_reply_due!) - due.getTime()) < 120_000);
  });

  test("tightening a team's target re-times its running clocks; reset goes back to the workspace", async () => {
    const L = await lib();
    const now = Date.now();
    const hoursA = await L.hoursForTeam(ids.teamA);
    const { addBusinessMinutes } = await import("../src/lib/helpdesk/sla");
    const t = await insertTicket(ids.teamA, { created_at: new Date(now), first_reply_due: addBusinessMinutes(now, 240, hoursA), resolve_due: addBusinessMinutes(now, 960, hoursA) });
    const replied = await insertTicket(ids.teamA, {
      created_at: new Date(now),
      first_replied_at: new Date(now),
      first_reply_due: addBusinessMinutes(now, 240, hoursA),
      resolve_due: addBusinessMinutes(now, 960, hoursA),
    });
    const { PUT } = await routes.teamSla();
    const url = `/api/helpdesk/admin/calendars/teams/${ids.teamA}/sla`;
    const r = await call(PUT, req(url, s("configurer"), { targets: [{ priority: "normal", first_reply_minutes: 60, resolve_minutes: 960 }] }, "PUT"), { teamId: String(ids.teamA) });
    assert.equal(r.status, 200);
    assert.ok(r.body.retimed >= 1);
    const d = await ticketDues(t);
    assert.ok(Math.abs(Date.parse(d.first_reply_due!) - addBusinessMinutes(now, 60, hoursA).getTime()) < 120_000);
    assert.equal((await ticketDues(replied)).first_reply_due, addBusinessMinutes(now, 240, hoursA).toISOString(), "a met clock keeps its due");
    const reset = await call(PUT, req(url, s("configurer"), { targets: null }, "PUT"), { teamId: String(ids.teamA) });
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body.view.targets, []);
    assert.equal((await L.slaPolicyForTeam("normal", ids.teamA))?.source, "workspace");
    assert.ok((await auditRows("helpdesk.team.sla_reset")).some((x) => Number(x.target_id) === ids.teamA));
  });

  test("the preview: a team and a priority use the team's own target and explain the closure", async () => {
    const { PUT } = await routes.teamSla();
    await call(PUT, req(`/api/helpdesk/admin/calendars/teams/${ids.teamA}/sla`, s("configurer"), { targets: [{ priority: "urgent", first_reply_minutes: 90, resolve_minutes: 480 }] }, "PUT"), {
      teamId: String(ids.teamA),
    });
    const { POST } = await routes.preview();
    // Thu 24 Dec 2026 16:00 GMT + 90: 60 on Thursday, Christmas (yearly) and the weekend, Mon 28 Dec is the substitute day → Tue 29 Dec 09:30.
    const r = await call(POST, req("/api/helpdesk/admin/calendars/preview", s("configurer"), { team_id: ids.teamA, start: "2026-12-24T16:00:00Z", priority: "urgent" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.due, "2026-12-29T09:30:00.000Z");
    assert.equal(r.body.target.source, "team");
    assert.equal(r.body.target.minutes, 90);
    assert.ok(r.body.lines.some((l: string) => /Christmas Day/.test(l) && /Boxing Day/.test(l)), r.body.lines.join(" | "));
    const m = await call(POST, req("/api/helpdesk/admin/calendars/preview", s("configurer"), { calendar_id: calB, start: "2026-11-09T12:00:00Z", minutes: 60 }));
    assert.equal(m.body.due, "2026-11-09T15:00:00.000Z");
    assert.match(m.body.summary, /opens today 09:00/);
    assert.equal((await call(POST, req("/api/helpdesk/admin/calendars/preview", s("configurer"), { start: "nope", minutes: 60 }))).status, 400);
  });

  test(".ics import, copy to next year, and edits", async () => {
    const sets = await routes.sets();
    const created = await call(sets.POST, req("/api/helpdesk/admin/holiday-sets", s("configurer"), { name: `${STAMP} Imported` }));
    const id = created.body.holiday_set.id;
    setIds.push(id);
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260403",
      "SUMMARY:Good Friday",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260406",
      "SUMMARY:Easter Monday",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20200101",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:New Year's Day",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const form = new FormData();
    form.set("file", new Blob([ics], { type: "text/calendar" }), "uk.ics");
    const up = new Request(`http://localhost/api/helpdesk/admin/holiday-sets/${id}/import`, { method: "POST", headers: { cookie: `compass_session=${s("configurer")}` }, body: form });
    const r = await call((await routes.importIcs()).POST, up, { id: String(id) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.added.length, 3);
    const again = await call((await routes.importIcs()).POST, req(`/api/helpdesk/admin/holiday-sets/${id}/import`, s("configurer"), { ics }), { id: String(id) });
    assert.equal(again.body.duplicates, 3);
    assert.equal((await call((await routes.importIcs()).POST, req(`/api/helpdesk/admin/holiday-sets/${id}/import`, s("configurer"), { ics: "https://example.com/x.ics" }), { id: String(id) })).status, 400);
    const copy = await call((await routes.copyYear()).POST, req(`/api/helpdesk/admin/holiday-sets/${id}/copy-year`, s("configurer"), { from_year: 2026 }), { id: String(id) });
    assert.equal(copy.status, 200);
    assert.deepEqual(copy.body.added.map((h: any) => h.date).sort(), ["2027-04-03", "2027-04-06"]);
    const set = await call((await routes.set()).GET, req(`/api/helpdesk/admin/holiday-sets/${id}`, s("configurer")), { id: String(id) });
    assert.equal(set.body.holiday_set.holidays.length, 5);
    const gf = set.body.holiday_set.holidays.find((h: any) => h.date === "2027-04-03");
    const edit = await call((await routes.holiday()).PATCH, req(`/api/helpdesk/admin/holiday-sets/${id}/holidays/${gf.id}`, s("configurer"), { date: "2027-03-26", closed_from: "12:00" }, "PATCH"), {
      id: String(id),
      holidayId: String(gf.id),
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.holiday.closed_from, "12:00");
    assert.ok((await auditRows("helpdesk.holiday_set.updated")).some((x) => Number(x.target_id) === id && x.details.imported?.added === 3));
    const del = await call((await routes.set()).DELETE, req(`/api/helpdesk/admin/holiday-sets/${id}`, s("configurer"), undefined, "DELETE"), { id: String(id) });
    assert.equal(del.status, 200);
    assert.ok((await auditRows("helpdesk.holiday_set.deleted")).some((x) => Number(x.target_id) === id));
  });

  test("deleting a calendar moves its teams to the default; the default can't be deleted", async () => {
    const { DELETE } = await routes.calendar();
    const list = await call((await routes.calendars()).GET, req("/api/helpdesk/admin/calendars", s("configurer")));
    const def = list.body.default_id;
    const no = await call(DELETE, req(`/api/helpdesk/admin/calendars/${def}`, s("configurer"), undefined, "DELETE"), { id: String(def) });
    assert.equal(no.status, 409);
    const r = await call(DELETE, req(`/api/helpdesk/admin/calendars/${calB}`, s("configurer"), undefined, "DELETE"), { id: String(calB) });
    assert.equal(r.status, 200);
    const L = await lib();
    assert.equal((await L.hoursForTeam(ids.teamB)).calendar?.id, def);
    assert.ok((await auditRows("helpdesk.calendar.deleted")).some((x) => Number(x.target_id) === calB && x.details.teams_moved_to_default.includes(ids.teamB)));
  });
});

// Helpdesk 1.19.2 Status page services per team (agent W6): a team follows
// chosen Status page services with a pop-up level each (teams.manage, or
// agents.manage_team in that team; audited); the sync turns the services'
// states into episodes and tells each team's agents once per episode and
// level (desk event service_down), and again when it recovers; the desk's
// view shows an agent only their teams' services (never every one), one
// pop-up per person per episode (dismissal remembered, recovery note for
// those who saw it), the queue banner per team ("Hide for today" per
// person, level "off" still shows it), and the declare prefill; a major
// incident declared from a service records it and, when asked, asks its
// runners to solve once the service is operational again (never solved
// by itself).
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-incidents does). Parallel-safe: teams,
// people, tickets and the Status page services are this file's own
// (STAMP); the sync is limited to them. The shared dev server's minute
// tick may sync these services too: every notice is checked in the
// database (bell rows), whichever instance sent it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-status-teams.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-status-teams.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-status-teams.virtual.js");
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
  ee.exports = {
    ee: () => ({ present: true, features: licensed ? ["helpdesk"] : [] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => licensed && feature === "helpdesk",
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const shared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const dbCore = require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const incidents = require("../src/lib/helpdesk/incidents") as typeof import("../src/lib/helpdesk/incidents");
const st = require("../src/lib/helpdesk/status-teams") as typeof import("../src/lib/helpdesk/status-teams");
const st$ = require("../src/lib/helpdesk/status-teams-shared") as typeof import("../src/lib/helpdesk/status-teams-shared");
const inc$ = require("../src/lib/helpdesk/incidents-shared") as typeof import("../src/lib/helpdesk/incidents-shared");
const prefs$ = require("../src/lib/helpdesk/notify-prefs-shared") as typeof import("../src/lib/helpdesk/notify-prefs-shared");
const policy = require("../src/lib/notify-policy-shared") as typeof import("../src/lib/notify-policy-shared");
const labels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const viewRoute = require("../src/app/api/helpdesk/team-status/route") as typeof import("../src/app/api/helpdesk/team-status/route");
const teamRoute = require("../src/app/api/helpdesk/team-status/teams/[id]/route") as typeof import("../src/app/api/helpdesk/team-status/teams/[id]/route");
const declareRoute = require("../src/app/api/helpdesk/team-status/declare/route") as typeof import("../src/app/api/helpdesk/team-status/declare/route");
const watchRoute = require("../src/app/api/helpdesk/team-status/incident/route") as typeof import("../src/app/api/helpdesk/team-status/incident/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";
import type { TeamStatusView } from "../src/lib/helpdesk/status-teams-shared";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method?: string): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdst-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
let T1 = 0;
let T2 = 0;
const S: Record<string, number> = {};

async function person(key: string, name: string): Promise<Person> {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, addr]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  P[key] = { id, session, name, email: addr };
  return P[key];
}
async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  roleIds.push(r.rows[0].id);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [r.rows[0].id, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [r.rows[0].id, userId]);
}
async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}
async function member(teamId: number, userId: number, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [teamId, userId, role]);
}
async function service(key: string, name: string) {
  S[key] = (await fixtureQuery("INSERT INTO status_services (name, provider, source_url, status) VALUES ($1, 'manual', '', 'operational') RETURNING id", [name])).rows[0].id;
}
async function setState(key: string, status: string, detail = "") {
  await pool().query("UPDATE status_services SET status = $2, status_detail = $3, last_changed_at = now() WHERE id = $1", [S[key], status, detail]);
}
const sync = () => st.syncTeamStatus({ serviceIds: Object.values(S), wait: true });
const view = async (who: Person): Promise<TeamStatusView> => {
  const r = await call(viewRoute.GET, req("/team-status", who.session));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const mark = (who: Person, body: Record<string, unknown>) => call(viewRoute.POST, req("/team-status", who.session, body));
const putTeam = (who: Person, team: number, services: unknown[]) => call(teamRoute.PUT, req(`/team-status/teams/${team}`, who.session, { services }, "PUT"), { id: String(team) });
const bells = async (who: Person, title: string) =>
  Number((await pool().query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title = $2", [who.id, title])).rows[0].n);
/** A bell may come from this process or the dev server's tick: wait briefly for the count to settle. */
async function bellsSoon(who: Person, title: string, want: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < 40; i++) {
    n = await bells(who, title);
    if (n >= want) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 150));
  return bells(who, title);
}
const name = (k: string) => `${STAMP} ${k}`;

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
  st.setDeskSyncForTests(false);
  for (const [k, n] of [
    ["agent", "Ana Agent"],
    ["agent2", "Ben Agent"],
    ["lead", "Lee Lead"],
    ["other", "Oda Otherteam"],
    ["manager", "Max Manager"],
    ["lead2", "Lia Lead"],
    ["nostatus", "Nat Nostatus"],
    ["req", "Tom Becker"],
  ] as const) {
    await person(k, n);
  }
  // The Status page's own permission (status.read) comes with the built-in Viewer
  // role every account gets; Nat stands for a workspace role without it.
  // Deleting Nat's Viewer assignment is not enough: every process's schema
  // bootstrap re-adds a ladder rung's missing assignment (db.ts
  // migrateLadderToAssignments), so any test file starting in parallel would
  // hand status.read back. Nat's rung names no built-in role instead: the
  // ladder trigger drops the Viewer row and the backfill has nothing to restore.
  await pool().query("UPDATE users SET role = $2 WHERE id = $1", [P.nostatus.id, `${STAMP}-norung`]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = $1", [P.nostatus.id]);
  await grant(P.nostatus.id, ["helpdesk.request"], "nostatus");
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9301) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9302) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await deskRole(P.agent.id, "agent");
  await deskRole(P.agent2.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.other.id, "agent");
  await deskRole(P.manager.id, "manager");
  await deskRole(P.lead2.id, "team_lead");
  await deskRole(P.nostatus.id, "team_lead");
  await member(T1, P.agent.id);
  await member(T1, P.lead.id, "lead");
  await member(T1, P.lead2.id, "lead");
  await member(T1, P.nostatus.id, "lead");
  await member(T2, P.other.id);
  await member(T2, P.agent2.id);
  await service("mail", name("Microsoft 365"));
  await service("vpn", name("VPN (internal)"));
  await service("hr", name("Payroll"));
  await service("zoom", name("Zoom"));
  await service("flap", name("Flaky feed"));
  await service("maint", name("Okta"));
  await service("late", name("Late service"));
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  st.setDeskSyncForTests(true);
  licensed = true;
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR subject LIKE $2", [[T1, T2], `${STAMP}%`])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_incidents WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM status_services WHERE id = ANY($1)", [Object.values(S)]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (action = 'helpdesk.team_status.solve_asked' AND target_label LIKE $2)", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Pure pieces ---------------------------------------------------------------------

describe("shared", () => {
  test("pop-up levels: outage and degraded, outage only, off", () => {
    assert.equal(st$.popupApplies("degraded", "degraded"), true);
    assert.equal(st$.popupApplies("degraded", "outage"), true);
    assert.equal(st$.popupApplies("outage", "degraded"), false);
    assert.equal(st$.popupApplies("outage", "outage"), true);
    assert.equal(st$.popupApplies("off", "outage"), false);
    assert.equal(st$.popupApplies("degraded", "operational"), false);
    assert.deepEqual(st$.POPUP_LEVELS.map((l) => st$.POPUP_LEVEL_LABEL[l]), ["Outage and degraded", "Outage only", "Off (banner only)"]);
  });

  test("suggested words and title come from the service's name", () => {
    assert.deepEqual(st$.suggestWords("Microsoft 365"), ["mail", "email", "outlook"]);
    assert.deepEqual(st$.suggestWords("VPN (internal)"), ["vpn"]);
    assert.deepEqual(st$.suggestWords("Building access (internal)"), ["building", "access"]);
    assert.deepEqual(st$.suggestWords("Zoom"), ["zoom"]);
    // W1's rule matches and accepts words of three letters or more.
    assert.deepEqual(st$.suggestWords("HR Portal"), ["portal"]);
    assert.deepEqual(st$.suggestWords("IT Helpdesk"), ["helpdesk"]);
    assert.deepEqual(st$.suggestWords("HR"), []);
    for (const n of ["HR Portal", "IT Helpdesk", "Okta", "Microsoft 365", "Entra ID", "VPN (internal)", "Building access (internal)"]) {
      const words = st$.suggestWords(n);
      assert.doesNotThrow(() => inc$.cleanMatch(words.join(", ")), n);
      for (const w of words) assert.ok(inc$.matchesRule(`about ${w} today`, w), `${n}: ${w} matches`);
    }
    assert.equal(st$.isRecovered("operational"), true);
    assert.equal(st$.isRecovered("maintenance"), true);
    assert.equal(st$.isRecovered("unknown"), false);
    assert.equal(st$.isRecovered("degraded"), false);
    assert.equal(st$.suggestTitle("Zoom", "outage"), "Zoom is down");
    assert.equal(st$.suggestTitle("Zoom", "degraded"), "Zoom is degraded");
  });

  test("a PUT body is checked", () => {
    assert.deepEqual(st$.validateTeamServices({ services: [{ service_id: 3 }, { service_id: 3, popup_level: "off" }] }), [{ service_id: 3, popup_level: "degraded" }]);
    assert.throws(() => st$.validateTeamServices({ services: [{ service_id: 1, popup_level: "loud" }] }), /outage and degraded/);
    assert.throws(() => st$.validateTeamServices({}), /list/);
    assert.throws(() => st$.validateTeamServices({ services: [{ service_id: "x" }] }), /id/);
  });

  test("the desk event is in the catalog with bell and push on by default; labels and lock key are their own", () => {
    assert.ok(prefs$.HD_NOTIFY_EVENTS.includes("service_down"));
    assert.deepEqual(prefs$.HD_NOTIFY_EVENT_INFO.service_down.defaults, { push: true, email: false, bell: true });
    const ev = policy.NOTIFY_EVENTS.find((e) => e.id === "desk_service_down");
    assert.ok(ev, "listed in the notification policy");
    assert.equal(ev!.label, "A service your team uses is down");
    for (const k of ["helpdesk.team_status.services_changed", "helpdesk.team_status.incident_watched", "helpdesk.team_status.solve_asked"]) assert.ok(labels.hasActionLabel(k), k);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const keys = [
      (require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla")).SLA_SWEEP_LOCK,
      (require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars")).CALENDAR_RECOMPUTE_LOCK,
      (require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine")).ASSIGNMENT_SWEEP_LOCK,
      (require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention")).RETENTION_LOCK,
      (require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring")).RECURRING_SWEEP_LOCK,
    ];
    /* eslint-enable @typescript-eslint/no-require-imports */
    assert.ok(!keys.includes(st.STATUS_TEAMS_LOCK));
  });
});

// --- Team settings ---------------------------------------------------------------------

describe("team settings", () => {
  test("a team's lead and teams.manage may choose; an agent and another team's lead may not", async () => {
    const lead = await call(teamRoute.GET, req(`/team-status/teams/${T1}`, P.lead.session), { id: String(T1) });
    assert.equal(lead.status, 200, JSON.stringify(lead.body));
    assert.ok(lead.body.services.some((s: { id: number }) => s.id === S.mail), "every Status page service is listed");
    assert.equal((await call(teamRoute.GET, req(`/team-status/teams/${T1}`, P.agent.session), { id: String(T1) })).status, 403);
    assert.equal((await call(teamRoute.GET, req(`/team-status/teams/${T2}`, P.lead.session), { id: String(T2) })).status, 403);
    assert.equal((await putTeam(P.lead, T2, [{ service_id: S.hr }])).status, 403);
    assert.equal((await putTeam(P.agent, T1, [{ service_id: S.mail }])).status, 403);

    const put = await putTeam(P.lead, T1, [
      { service_id: S.mail, popup_level: "degraded" },
      { service_id: S.vpn, popup_level: "degraded" },
      { service_id: S.zoom, popup_level: "off" },
    ]);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.changed.added.sort(), [name("Microsoft 365"), name("VPN (internal)"), name("Zoom")].sort());
    const audited = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.team_status.services_changed' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.lead.id]);
    assert.equal(audited.rows[0].details.team, `${STAMP} IT`);

    const mgr = await putTeam(P.manager, T2, [
      { service_id: S.hr, popup_level: "degraded" },
      { service_id: S.mail, popup_level: "outage" },
    ]);
    assert.equal(mgr.status, 200, JSON.stringify(mgr.body));
    assert.equal((await putTeam(P.manager, T2, [{ service_id: 999999999 }])).status, 409, "an unknown service");
    // Unchanged PUT: nothing to audit.
    const before = Number((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.team_status.services_changed' AND actor_id = $1", [P.manager.id])).rows[0].n);
    await putTeam(P.manager, T2, [
      { service_id: S.hr, popup_level: "degraded" },
      { service_id: S.mail, popup_level: "outage" },
    ]);
    const after = Number((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.team_status.services_changed' AND actor_id = $1", [P.manager.id])).rows[0].n);
    assert.equal(after, before);
  });

  test("an agent sees only their teams' services; the pill is quiet while all are operational", async () => {
    await sync();
    const v = await view(P.agent);
    const ids = v.services.map((s) => s.id).sort();
    assert.deepEqual(ids, [S.mail, S.vpn, S.zoom].sort(), "T1's three, never T2's Payroll");
    assert.equal(v.popups.length, 0);
    assert.equal(v.banners.filter((b) => b.team_id === T1).length, 0);
    assert.equal(v.teams.find((t) => t.id === T1)?.can_manage, false);
    const lead = await view(P.lead);
    assert.equal(lead.teams.find((t) => t.id === T1)?.can_manage, true);
    assert.equal(lead.manage_all, false);
  });
});

// --- Episodes, pop-ups, banners -------------------------------------------------------

describe("when a followed service has trouble", () => {
  test("degraded: T1 (outage and degraded) is told once; T2 (outage only) is not", async () => {
    await setState("mail", "degraded", "Exchange Online: delayed mail delivery");
    await sync();
    await sync();
    const title = `${name("Microsoft 365")} is degraded`;
    assert.equal(await bellsSoon(P.agent, title, 1), 1, "one bell per agent per episode and level");
    assert.equal(await bellsSoon(P.lead, title, 1), 1);
    assert.equal(await bells(P.other, title), 0, "outage only");
    assert.equal(await bells(P.nostatus, title), 0, "no status.read: never told");

    const v = await view(P.agent);
    const pop = v.popups.find((p) => p.service_id === S.mail);
    assert.ok(pop, JSON.stringify(v.popups));
    assert.equal(pop!.kind, "down");
    assert.equal(pop!.team_id, T1);
    assert.equal(pop!.can_declare, false, "an Agent doesn't run major incidents");
    assert.equal(pop!.detail, "Exchange Online: delayed mail delivery");
    assert.ok(v.banners.some((b) => b.team_id === T1 && b.service_id === S.mail));
    const lead = await view(P.lead);
    assert.equal(lead.popups.find((p) => p.service_id === S.mail)?.can_declare, true, "a Team lead does");
    // T2's agents see the banner in T2's queue, but no pop-up at outage-only.
    const other = await view(P.other);
    assert.equal(other.popups.filter((p) => p.service_id === S.mail).length, 0);
    assert.ok(other.banners.some((b) => b.team_id === T2 && b.service_id === S.mail));
  });

  test("dismissing is remembered; Hide for today hides the banner for that person only", async () => {
    const ep = (await view(P.agent)).popups.find((p) => p.service_id === S.mail)!.episode_id;
    assert.equal((await mark(P.agent, { action: "dismiss", episode_id: ep })).status, 200);
    assert.equal((await view(P.agent)).popups.filter((p) => p.service_id === S.mail).length, 0);
    assert.equal((await mark(P.agent, { action: "hide_banner", episode_id: ep, until: new Date(Date.now() + 3_600_000).toISOString() })).status, 200);
    assert.equal((await view(P.agent)).banners.filter((b) => b.service_id === S.mail).length, 0);
    assert.ok((await view(P.lead)).banners.some((b) => b.service_id === S.mail), "the lead still sees it");
    assert.equal((await mark(P.agent, { action: "wave", episode_id: ep })).status, 400);
    assert.equal((await mark(P.agent, { action: "dismiss", episode_id: 2147483000 })).status, 404);
  });

  test("escalating to outage reaches T2 (outage only) once, and not T1 again", async () => {
    await setState("mail", "outage", "Exchange Online is down");
    await sync();
    const down = `${name("Microsoft 365")} is down`;
    assert.equal(await bellsSoon(P.other, down, 1), 1);
    assert.equal(await bellsSoon(P.agent2, down, 1), 1);
    assert.equal(await bells(P.agent, down), 0, "T1 was told at degraded");
    const other = await view(P.other);
    assert.ok(other.popups.some((p) => p.service_id === S.mail && p.state === "outage"));
    assert.equal((await view(P.agent)).popups.filter((p) => p.service_id === S.mail).length, 0, "still dismissed");
  });

  test("level off: the queue banner without a pop-up", async () => {
    await setState("zoom", "outage", "Meetings fail to start");
    await sync();
    const v = await view(P.agent);
    assert.equal(v.popups.filter((p) => p.service_id === S.zoom).length, 0);
    assert.ok(v.banners.some((b) => b.service_id === S.zoom && b.team_id === T1));
    assert.equal(await bells(P.agent, `${name("Zoom")} is down`), 0);
  });

  test("recovery: a note for those who saw the pop-up, and a bell for those told", async () => {
    await setState("mail", "operational");
    await sync();
    const back = `${name("Microsoft 365")} is operational again`;
    assert.equal(await bellsSoon(P.agent, back, 1), 1);
    assert.equal(await bellsSoon(P.other, back, 1), 1);
    const v = await view(P.agent);
    const rec = v.popups.find((p) => p.service_id === S.mail);
    assert.equal(rec?.kind, "recovered", "the agent saw (and dismissed) the pop-up");
    assert.equal(v.banners.filter((b) => b.service_id === S.mail).length, 0);
    await mark(P.agent, { action: "dismiss_recovery", episode_id: rec!.episode_id });
    assert.equal((await view(P.agent)).popups.filter((p) => p.service_id === S.mail).length, 0);
    const ep = await pool().query("SELECT ended_at, worst FROM hd_status_episodes WHERE id = $1", [rec!.episode_id]);
    assert.ok(ep.rows[0].ended_at);
    assert.equal(ep.rows[0].worst, "outage");
    await setState("zoom", "operational");
    await sync();
  });

  test("unknown keeps the episode open; deleting a service or a team cascades", async () => {
    await setState("vpn", "degraded", "Slow");
    await sync();
    await setState("vpn", "unknown");
    await sync();
    const open = await pool().query("SELECT id FROM hd_status_episodes WHERE service_id = $1 AND ended_at IS NULL", [S.vpn]);
    assert.equal(open.rows.length, 1);
    const tmp = (await fixtureQuery("INSERT INTO status_services (name, provider, status) VALUES ($1, 'manual', 'operational') RETURNING id", [name("Temp")])).rows[0].id;
    await pool().query("INSERT INTO hd_team_status_services (team_id, service_id) VALUES ($1, $2)", [T2, tmp]);
    await pool().query("DELETE FROM status_services WHERE id = $1", [tmp]);
    assert.equal((await pool().query("SELECT 1 FROM hd_team_status_services WHERE service_id = $1", [tmp])).rows.length, 0);
    await setState("vpn", "operational");
    await sync();
  });

  test("unlicensed: the desk routes answer 402 and the sync does nothing", async () => {
    licensed = false;
    try {
      assert.equal((await call(viewRoute.GET, req("/team-status", P.agent.session))).status, 402);
      assert.equal(await st.syncTeamStatus({ serviceIds: Object.values(S) }), 0);
    } finally {
      licensed = true;
    }
  });
});

// --- Declaring from a service -----------------------------------------------------------

describe("declare from a service", () => {
  let incidentNumber = 0;

  test("the prefill: title, words and the team's open tickets that mention it since it changed", async () => {
    await setState("mail", "degraded", "Delayed mail");
    await sync();
    const mk = (subject: string, team = T1) =>
      dbCore.withTx((c) => tickets.insertTicketTx(c, { subject: `${STAMP} ${subject}`, body: "Hello", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, team_id: team }));
    const a = await mk("Outlook keeps asking for my password");
    const b = await mk("Email not arriving");
    await mk("Printer jam");
    await mk("Mail is slow", T2);
    const r = await call(declareRoute.GET, req(`/team-status/declare?service=${S.mail}&team=${T1}`, P.lead.session));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.title, `${name("Microsoft 365")} is degraded`);
    assert.deepEqual(r.body.words, ["mail", "email", "outlook"]);
    assert.deepEqual(r.body.tickets.map((t: { number: number }) => t.number).sort(), [a.number, b.number].sort(), "T1's, mentioning it, not the printer, not T2's");
    assert.equal((await call(declareRoute.GET, req(`/team-status/declare?service=${S.mail}&team=${T1}`, P.agent.session))).status, 403, "an Agent can't run incidents");

    // Declared (W1) with those tickets, then recorded and watched here.
    const input = incidents.validateDeclare({ team_id: T1, title: r.body.title, numbers: r.body.tickets.map((t: { number: number }) => t.number), match_text: r.body.words.join(", "), notify_on_link: false, banner: "off" });
    const d = await incidents.declareIncident({ id: P.lead.id, role: "viewer", name: P.lead.name, username: P.lead.name, email: P.lead.email }, input);
    await d.notices;
    incidentNumber = d.number;
    assert.equal((await call(watchRoute.POST, req("/team-status/incident", P.agent.session, { number: d.number, service_id: S.mail, ask_solve: true }))).status, 403);
    const w = await call(watchRoute.POST, req("/team-status/incident", P.lead.session, { number: d.number, service_id: S.mail, ask_solve: true }));
    assert.equal(w.status, 200, JSON.stringify(w.body));
    // Review fix (high): W1's Status page mirror is never set from here; the service lives in the watch only.
    const inc = await pool().query("SELECT status_service_id, status_incident_id FROM hd_incidents WHERE id = $1", [d.id]);
    assert.equal(inc.rows[0].status_service_id, null, "hd_incidents.status_service_id is W1's (needs status.incident_manage)");
    assert.equal(inc.rows[0].status_incident_id, null);
    const watch = await pool().query("SELECT service_id, ask_solve FROM hd_status_incident_watch WHERE incident_id = $1", [d.id]);
    assert.deepEqual(watch.rows[0], { service_id: S.mail, ask_solve: 1 });
    // Reopening the incident's ticket after it is solved never posts to the Status page.
    await pool().query("UPDATE hd_tickets SET status = 'solved' WHERE id = $1", [d.ticket_id]);
    await incidents.onIncidentTicketReopened(d.ticket_id);
    await pool().query("UPDATE hd_tickets SET status = 'open' WHERE id = $1", [d.ticket_id]);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM status_incidents WHERE service_id = $1", [S.mail])).rows[0].n, 0);
    assert.equal((await view(P.lead)).asks.length, 0, "not while it is still degraded");
    // Review fix: an open incident for the service replaces "Declare major incident" with a link to it.
    const lv = await view(P.lead);
    const pop = lv.popups.find((p) => p.service_id === S.mail);
    assert.equal(pop?.incident?.number, d.number, JSON.stringify(lv.popups));
    assert.equal(pop?.can_declare, false);
    const ban = lv.banners.find((b) => b.service_id === S.mail && b.team_id === T1);
    assert.equal(ban?.incident?.number, d.number);
    assert.equal(ban?.can_declare, false);
  });

  test("once operational again its runners are asked; nothing is solved by itself", async () => {
    await setState("mail", "operational");
    await sync();
    assert.equal(await bellsSoon(P.lead, `${name("Microsoft 365")} is operational again`, 1) >= 1, true);
    const v = await view(P.lead);
    const ask = v.asks.find((a) => a.number === incidentNumber);
    assert.ok(ask, JSON.stringify(v.asks));
    assert.equal(ask!.linked_open, 2);
    const t = await pool().query("SELECT t.status FROM hd_incidents i JOIN hd_tickets t ON t.id = i.ticket_id JOIN hd_tickets p ON p.number = $1 WHERE i.ticket_id = p.id", [incidentNumber]);
    assert.equal(t.rows[0].status, "open", "still open until someone clicks");
    assert.equal((await view(P.agent)).asks.length, 0, "only its runners");
    assert.equal((await view(P.lead2)).asks.length, 0, "the declarer could run it, so only they were asked");
    const asked = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.team_status.solve_asked' AND details->>'incident' = $1", [String(incidentNumber)]);
    assert.equal(asked.rows.length, 1);
    await mark(P.lead, { action: "dismiss_ask", incident_id: ask!.incident_id });
    assert.equal((await view(P.lead)).asks.length, 0, "Not now is remembered");
  });
});

// --- Review fixes ----------------------------------------------------------------------

describe("review fixes", () => {
  const lead2 = () => ({ id: P.lead2.id, role: "viewer" as const, name: P.lead2.name, username: P.lead2.name, email: P.lead2.email });
  async function declareOn(by: () => { id: number; role: "viewer"; name: string; username: string; email: string }, title: string) {
    const d = await incidents.declareIncident(by(), incidents.validateDeclare({ team_id: T1, title: `${STAMP} ${title}`, notify_on_link: false, banner: "off" }));
    await d.notices;
    return d;
  }

  test("status.read: without it the desk shows nothing from the Status page, settings and the prefill are refused", async () => {
    const v = await view(P.nostatus);
    assert.deepEqual([v.services.length, v.popups.length, v.banners.length, v.asks.length], [0, 0, 0, 0]);
    assert.equal(v.teams.find((t) => t.id === T1)?.can_manage, false);
    assert.equal((await call(teamRoute.GET, req(`/team-status/teams/${T1}`, P.nostatus.session), { id: String(T1) })).status, 403);
    assert.equal((await putTeam(P.nostatus, T1, [])).status, 403);
    assert.equal((await call(declareRoute.GET, req(`/team-status/declare?service=${S.mail}&team=${T1}`, P.nostatus.session))).status, 403);
    const recipients = await st.deskStatusRecipients(S.mail, "down", "degraded");
    assert.ok(recipients.has(P.agent.id) && !recipients.has(P.nostatus.id));
  });

  test("flapping: trouble back within ten minutes reopens the same episode; one down and one back notice", async () => {
    await pool().query("INSERT INTO hd_team_status_services (team_id, service_id, popup_level) VALUES ($1, $2, 'degraded')", [T1, S.flap]);
    const down = `${name("Flaky feed")} is degraded`;
    const back = `${name("Flaky feed")} is operational again`;
    for (let i = 0; i < 3; i++) {
      await setState("flap", "degraded", "Errors");
      await sync();
      await setState("flap", "operational");
      await sync();
    }
    const eps = await pool().query("SELECT id, ended_at FROM hd_status_episodes WHERE service_id = $1", [S.flap]);
    assert.equal(eps.rows.length, 1, "one spell");
    assert.equal(await bellsSoon(P.agent, down, 1), 1);
    assert.equal(await bellsSoon(P.agent, back, 1), 1);
  });

  test("a team that starts following (or raises its level) mid-episode is told once, then hears it is back", async () => {
    await pool().query("INSERT INTO hd_team_status_services (team_id, service_id, popup_level) VALUES ($1, $2, 'off')", [T2, S.late]);
    await setState("late", "outage", "Down");
    await sync();
    const down = `${name("Late service")} is down`;
    assert.equal(await bells(P.other, down), 0, "level off");
    assert.equal((await putTeam(P.manager, T2, [{ service_id: S.hr }, { service_id: S.mail, popup_level: "outage" }, { service_id: S.late, popup_level: "outage" }])).status, 200);
    await sync();
    await sync();
    assert.equal(await bellsSoon(P.other, down, 1), 1, "told once after raising the level");
    await setState("late", "operational");
    await sync();
    assert.equal(await bellsSoon(P.other, `${name("Late service")} is operational again`, 1), 1);
  });

  test("maintenance counts as recovered everywhere; an incident watched while unknown is asked once operational", async () => {
    await pool().query("INSERT INTO hd_team_status_services (team_id, service_id, popup_level) VALUES ($1, $2, 'degraded')", [T1, S.maint]);
    await setState("maint", "outage", "Sign-in fails");
    await sync();
    const a = await declareOn(lead2, "Okta sign-in fails");
    assert.equal((await call(watchRoute.POST, req("/team-status/incident", P.lead2.session, { number: a.number, service_id: S.maint, ask_solve: true }))).status, 200);
    await setState("maint", "maintenance", "Planned work");
    await sync();
    assert.equal(await bellsSoon(P.lead2, `${name("Okta")} is under maintenance`, 1) >= 1, true, "worded from the actual state");
    const ask = (await view(P.lead2)).asks.find((x) => x.number === a.number);
    assert.equal(ask?.state, "maintenance", "the card shows during maintenance too");

    // Watched while the service is in maintenance: asked at once.
    const b = await declareOn(lead2, "Okta follow-up");
    await call(watchRoute.POST, req("/team-status/incident", P.lead2.session, { number: b.number, service_id: S.maint, ask_solve: true }));
    assert.ok((await view(P.lead2)).asks.some((x) => x.number === b.number));

    // Watched while unknown (neither down nor recovered): asked when it becomes operational.
    await setState("maint", "unknown");
    const c = await declareOn(lead2, "Okta unknown");
    await call(watchRoute.POST, req("/team-status/incident", P.lead2.session, { number: c.number, service_id: S.maint, ask_solve: true }));
    assert.equal((await pool().query("SELECT asked_at FROM hd_status_incident_watch w JOIN hd_incidents i ON i.id = w.incident_id JOIN hd_tickets t ON t.id = i.ticket_id WHERE t.number = $1", [c.number])).rows[0].asked_at, null);
    await setState("maint", "operational");
    await sync();
    assert.ok((await view(P.lead2)).asks.some((x) => x.number === c.number));
  });

  test("solve asks go only to people who can still run the incident; else to the team's people who can", async () => {
    await setState("maint", "outage", "Again");
    await sync();
    const d = await declareOn(lead2, "Okta again");
    await call(watchRoute.POST, req("/team-status/incident", P.lead2.session, { number: d.number, service_id: S.maint, ask_solve: true }));
    await pool().query("UPDATE hd_tickets SET assignee_id = NULL WHERE id = $1", [d.ticket_id]);
    // The declarer leaves the team: they can't run it any more.
    await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T1, P.lead2.id]);
    try {
      await setState("maint", "operational");
      await sync();
      const asked = (await pool().query("SELECT user_id FROM hd_status_asks WHERE incident_id = $1 ORDER BY user_id", [d.id])).rows.map((r) => r.user_id);
      assert.deepEqual(asked, [P.lead.id], "the team's lead with status.read; not the former declarer, not Nat (no status.read)");
      assert.equal((await view(P.lead2)).asks.some((x) => x.number === d.number), false);
      assert.ok((await view(P.lead)).asks.some((x) => x.number === d.number));
    } finally {
      await member(T1, P.lead2.id, "lead");
    }
  });

  test("Not now marks go with the person's account", async () => {
    const tmp = await person("tmp", "Tim Temporary");
    const inc = (await pool().query("SELECT incident_id FROM hd_status_incident_watch WHERE service_id = ANY($1) LIMIT 1", [Object.values(S)])).rows[0].incident_id;
    await pool().query("INSERT INTO hd_status_asks (incident_id, user_id, dismissed_at) VALUES ($1, $2, now())", [inc, tmp.id]);
    await pool().query("DELETE FROM sessions WHERE user_id = $1", [tmp.id]);
    await pool().query("DELETE FROM users WHERE id = $1", [tmp.id]);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_status_asks WHERE user_id = $1", [tmp.id])).rows[0].n, 0);
  });

  test("the desk's poll answers without waiting for the sync", async () => {
    let started = 0;
    st.setDeskSyncForTests(() => {
      started++;
      return new Promise((r) => setTimeout(r, 5_000));
    });
    try {
      const t0 = Date.now();
      const first = await view(P.agent);
      assert.ok(Date.now() - t0 < 3_000, `answered in ${Date.now() - t0}ms`);
      assert.equal(started, 1);
      assert.equal(first.syncing, true, "tells the desk to ask again shortly");
      const second = await view(P.agent);
      assert.equal(started, 1, "one sync at a time");
      assert.equal(second.syncing, undefined);
    } finally {
      st.setDeskSyncForTests(false);
    }
  });

  test("the workspace's own status bell skips the people the desk tells", async () => {
    await setState("vpn", "outage", "Down");
    await sync();
    const down = await st.deskStatusRecipients(S.vpn, "down", "outage");
    assert.ok(down.has(P.agent.id) && down.has(P.lead.id));
    assert.ok(!down.has(P.other.id), "T2 doesn't follow VPN: the workspace bell is theirs");
    const up = await st.deskStatusRecipients(S.vpn, "up", "operational");
    assert.ok(up.has(P.agent.id), "told teams hear the desk's back notice instead");
    await setState("vpn", "operational");
    await sync();
    licensed = false;
    try {
      assert.equal((await st.deskStatusRecipients(S.vpn, "down", "outage")).size, 0, "without the helpdesk everyone keeps the workspace bell");
    } finally {
      licensed = true;
    }
  });
});

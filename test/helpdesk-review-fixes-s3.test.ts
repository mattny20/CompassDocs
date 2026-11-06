// Helpdesk 1.19.0 review fixes, area S3 (roles, notifications, push,
// digests, settings): one regression test per finding of the 1.19.0
// review this area fixed (#4, #14, #15, #16, #18, #19, #21, #28, #29,
// #30, #31, #38, #39, #40, #41, #42).
//
// Parallel-safe: every team, account, role, directory entry and queue row
// here is this file's own (STAMP). The desk matrix is changed only through
// roles.setRoleMatrixForTests (this process only, never the shared
// setting); no global setting is written.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-review-fixes-s3.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, deleteSession, deleteOtherSessions, sessionSid, updateUser, moveCustomRoleOffKey } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-s3.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-s3.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
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
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const shared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesAgents = require("../src/lib/helpdesk/roles-agents") as typeof import("../src/lib/helpdesk/roles-agents");
const access = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const review = require("../src/lib/helpdesk/review") as typeof import("../src/lib/helpdesk/review");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const notifyPrefs = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const push = require("../src/lib/helpdesk/push") as typeof import("../src/lib/helpdesk/push");
const settings = require("../src/lib/helpdesk/settings") as typeof import("../src/lib/helpdesk/settings");
const hdEmail = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const policy = require("../src/lib/notify-policy") as typeof import("../src/lib/notify-policy");
const policyShared = require("../src/lib/notify-policy-shared") as typeof import("../src/lib/notify-policy-shared");
const templates = require("../src/lib/email-templates") as typeof import("../src/lib/email-templates");
const membersRoute = require("../src/app/api/helpdesk/admin/teams/[id]/members/route") as typeof import("../src/app/api/helpdesk/admin/teams/[id]/members/route");
const agentRoute = require("../src/app/api/helpdesk/admin/agents/[userId]/route") as typeof import("../src/app/api/helpdesk/admin/agents/[userId]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

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

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hds3-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
  role: "viewer" | "admin";
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ticketIds: number[] = [];
const dirIds: number[] = [];
let T1 = 0;
let T2 = 0;

async function person(key: string, name: string, role: "viewer" | "admin" = "viewer"): Promise<Person> {
  const mailAddr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, $4, 'active', 'UTC') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    mailAddr,
    role,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  P[key] = { id, session, name, email: mailAddr, role };
  return P[key];
}

async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  const roleId = r.rows[0].id as number;
  roleIds.push(roleId);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [roleId, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [roleId, userId]);
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}

async function member(teamId: number, userId: number, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [teamId, userId, role]);
}

const teamRows = async (teamId: number) =>
  (await pool().query<{ user_id: number; role: string }>("SELECT user_id, role FROM hd_team_members WHERE team_id = $1 ORDER BY user_id", [teamId])).rows;

async function newTicket(subject: string, teamId: number | null, assigneeId: number | null = null) {
  const r = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number`,
    [`${STAMP} ${subject}`, P.req.id, P.req.name, P.req.email, teamId, assigneeId]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0] as { id: number; number: number };
}

let endpointN = 0;
async function device(userId: number, sid: string | null) {
  endpointN++;
  return push.subscribePush(
    userId,
    { endpoint: `https://fcm.googleapis.com/fcm/send/${STAMP}-${endpointN}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } },
    { userAgent: "Mozilla/5.0 Chrome/120", sessionSid: sid }
  );
}
const deviceCount = async (userId: number) =>
  (await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM hd_push_subscriptions WHERE user_id = $1", [userId])).rows[0].n;

before(async () => {
  // Push keys are sealed with the workspace encryption key. CI has no
  // writable /uploads key file, so every push test file uses the same fixed
  // test key; a pair stored under some other key (a local database) is
  // cleared so it is made afresh under this one.
  process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
  push.resetVapidCache();
  try {
    await push.vapidKeys();
  } catch {
    await pool().query("DELETE FROM settings WHERE key = 'helpdesk_vapid'");
    push.resetVapidCache();
  }
  await getSetting("__schema_bootstrap__");
  for (const [k, n, r] of [
    ["newbie", "Nia Newbie"],
    ["agent", "Ari Agent"],
    ["agent2", "Abe Agent"],
    ["lead", "Lena Lead"],
    ["lead2", "Lou Lead"],
    ["manager", "Milo Manager"],
    ["fresh", "Fay Fresh"],
    ["loner", "Lon Noteam"],
    ["req", "Rae Requester"],
    ["dadmin", "Dee Directoryadmin", "admin"],
  ] as const) {
    await person(k, n, (r ?? "viewer") as "viewer" | "admin");
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9101) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9102) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.agent.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.lead2.id, "team_lead");
  await deskRole(P.manager.id, "manager");
  await deskRole(P.loner.id, "agent");
  await member(T1, P.newbie.id);
  await member(T1, P.agent.id);
  await member(T1, P.lead.id, "lead");
  await member(T1, P.lead2.id, "lead");
  await member(T1, P.manager.id);
  // agent2: a derived Agent (helpdesk.agent, no assigned role) in T1.
  await grant(P.agent2.id, ["helpdesk.agent"], "agent2");
  await member(T1, P.agent2.id);
  await grant(P.req.id, ["helpdesk.request"], "req");
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  notifyPrefs.setAgentEmailSenderForTests(null);
  push.setPushTransportForTests(null);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notify_digest_queue WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("UPDATE users SET directory_person_id = NULL WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dirIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- #4 Team members PUT by a Team lead --------------------------------------------

describe("#4 a Team lead's team-members PUT follows the role ladder", () => {
  const put = (by: Person, members: unknown, team = T1) =>
    call(membersRoute.PUT, req(`/admin/teams/${team}/members`, by.session, { members }, "PUT"), { id: String(team) });
  const current = async () => (await teamRows(T1)).map((r) => ({ user_id: r.user_id, role: r.role }));

  test("a lead can't make a derived Agent a lead", async () => {
    const list = (await current()).map((m) => (m.user_id === P.agent2.id ? { ...m, role: "lead" } : m));
    const r = await put(P.lead, list);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal((await teamRows(T1)).find((m) => m.user_id === P.agent2.id)?.role, "agent");
    assert.equal((await roles.hdRoleOf(P.agent2.id))?.role, "agent");
  });

  test("a lead can't take a Manager or another lead out of the team", async () => {
    const before = await current();
    assert.equal((await put(P.lead, before.filter((m) => m.user_id !== P.manager.id))).status, 403);
    assert.equal((await put(P.lead, before.filter((m) => m.user_id !== P.lead2.id))).status, 403);
    assert.equal((await put(P.lead, before.filter((m) => m.user_id !== P.lead.id))).status, 403, "not themselves either");
    assert.deepEqual(await current(), before, "nothing changed");
  });

  test("a lead adds someone new (as an agent) and removes an Agent", async () => {
    const list = [...(await current()).filter((m) => m.user_id !== P.agent2.id), { user_id: P.fresh.id, role: "agent" }];
    const r = await put(P.lead, list);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = await teamRows(T1);
    assert.equal(rows.find((m) => m.user_id === P.fresh.id)?.role, "agent");
    assert.ok(!rows.some((m) => m.user_id === P.agent2.id));
    // Put agent2 back for the rest of the file (a Manager: teams.manage).
    const back = await put(P.manager, [...(await current()), { user_id: P.agent2.id, role: "agent" }]);
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });

  test("a lead can't pull in an Agent of another team", async () => {
    await member(T2, P.loner.id);
    try {
      const r = await put(P.lead, [...(await current()), { user_id: P.loner.id, role: "agent" }]);
      assert.equal(r.status, 403, JSON.stringify(r.body));
    } finally {
      await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T2, P.loner.id]);
    }
  });

  test("a Manager (teams.manage) still sets the lead flag of a derived member", async () => {
    const list = (await current()).map((m) => (m.user_id === P.agent2.id ? { ...m, role: "lead" } : m));
    const r = await put(P.manager, list);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await teamRows(T1)).find((m) => m.user_id === P.agent2.id)?.role, "lead");
    const back = await put(P.manager, list.map((m) => (m.user_id === P.agent2.id ? { ...m, role: "agent" } : m)));
    assert.equal(back.status, 200);
  });
});

// --- #19 A lead and desk members in no team ------------------------------------------

describe("#19 a Team lead manages only their own teams' members", () => {
  test("PATCH on a desk member who is in no team is refused, and the row isn't offered", async () => {
    const r = await call(agentRoute.PATCH, req(`/admin/agents/${P.loner.id}`, P.lead.session, { role: "newbie" }, "PATCH"), { userId: String(P.loner.id) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal((await roles.hdRoleOf(P.loner.id))?.role, "agent");
    const view = await roles.hdCapsFor(P.lead);
    const loner = await rolesAgents.getDeskAgent(P.loner.id);
    assert.ok(loner);
    assert.equal(rolesAgents.rowManageable(P.lead.id, view, loner!), false);
  });

  test("a Manager still can", async () => {
    const r = await call(agentRoute.PATCH, req(`/admin/agents/${P.loner.id}`, P.manager.session, { role: "newbie" }, "PATCH"), { userId: String(P.loner.id) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await deskRole(P.loner.id, "agent");
  });
});

// --- #18 tickets.view_team is enforced -----------------------------------------------------

describe("#18 tickets.view_team decides team queue access", () => {
  test("a Newbie without it works only what is assigned to them", async () => {
    const team = { ...(await newTicket("queue", T1)), requester_id: P.req.id, team_id: T1, assignee_id: null };
    const mine = { ...(await newTicket("assigned", T1, P.newbie.id)), requester_id: P.req.id, team_id: T1, assignee_id: P.newbie.id };
    assert.equal(await access.canWorkTicket(P.newbie, team), true, "with the default matrix");
    const m = { ...shared.HD_DEFAULT_MATRIX, newbie: shared.HD_DEFAULT_MATRIX.newbie.filter((c) => c !== "tickets.view_team") };
    roles.setRoleMatrixForTests(m);
    try {
      assert.deepEqual(await access.agentTeamIds(P.newbie), []);
      assert.equal(await access.canWorkTicket(P.newbie, team), false);
      assert.equal(await access.canWorkTicket(P.newbie, mine), true, "assigned tickets stay");
      assert.deepEqual(await access.agentTeamIds(P.agent), [T1], "other roles unchanged");
    } finally {
      roles.setRoleMatrixForTests(null);
    }
  });
});

// --- #21 Requester card and directory visibility --------------------------------------------

describe("#21 the requester card follows the directory's visibility rules", () => {
  test("a hidden manager is never named", async () => {
    const mk = async (name: string, hidden = 0) => {
      const r = await fixtureQuery("INSERT INTO directory_people (name, title, hidden) VALUES ($1, 'Analyst', $2) RETURNING id", [`${name} ${STAMP}`, hidden]);
      dirIds.push(r.rows[0].id);
      return r.rows[0].id as number;
    };
    const self = await mk("Rae");
    const boss = await mk("Hidden Boss", 1);
    await pool().query("INSERT INTO directory_person_links (person_id, field_key, target_id) VALUES ($1, 'manager', $2)", [self, boss]);
    await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [P.req.id, self]);
    const t = { id: 0, requester_id: P.req.id, requester_email: P.req.email, requester_name: P.req.name } as never;
    const card = await detail.requesterCard(t, P.agent);
    assert.equal(card.title, "Analyst");
    assert.equal(card.manager, "", "hidden person");
    const visible = await mk("Seen Boss");
    await pool().query("DELETE FROM directory_person_links WHERE person_id = $1", [self]);
    await pool().query("INSERT INTO directory_person_links (person_id, field_key, target_id) VALUES ($1, 'manager', $2)", [self, visible]);
    assert.equal((await detail.requesterCard(t, P.dadmin)).manager, `Seen Boss ${STAMP}`);
  });
});

// --- #14 Internal-note mail ------------------------------------------------------------------

describe("#14 an internal note is mailed with its own template", () => {
  test("hd_internal_note, marked internal, no reply-by-email", async () => {
    const def = templates.templateDef("hd_internal_note");
    assert.ok(def);
    assert.doesNotMatch(def!.body, /\bor reply to this email/i);
    assert.match(def!.body, /Don't reply to this email/);
    assert.match(def!.body, /internal note/i);
    assert.ok(!def!.tags.some((t) => t.tag === "thread_ref"), "no thread reference");
    const t = await newTicket("note", T1, P.agent.id);
    const m = await fixtureQuery("INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body) VALUES ($1, $2, $3, 'internal', 'Legal is reviewing') RETURNING id", [
      t.id,
      P.lead.id,
      P.lead.name,
    ]);
    const sent: { userId: number; template: string }[] = [];
    notifyPrefs.setAgentEmailSenderForTests(async (userId, template) => {
      sent.push({ userId, template });
      return true;
    });
    try {
      await pool().query(
        "INSERT INTO hd_notify_prefs (user_id, prefs) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs",
        [P.agent.id, JSON.stringify({ matrix: { mention_or_note: { email: true, bell: true, push: false } } })]
      );
      await notify.notifyReply(t.id, m.rows[0].id, { actorId: P.lead.id });
      assert.deepEqual(sent, [{ userId: P.agent.id, template: "hd_internal_note" }]);
    } finally {
      notifyPrefs.setAgentEmailSenderForTests(null);
      await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [P.agent.id]);
    }
  });

  test("the catalog lists it for notes", () => {
    assert.ok(policyShared.notifyEvent("desk_mention_or_note")?.templates?.includes("hd_internal_note"));
    assert.equal(hdEmail.HD_NOTE_NOTICE_TEMPLATE, "hd_internal_note");
  });
});

// --- #29 Review notices through preferences -------------------------------------------------

describe("#29 review notices go through the desk's preferences", () => {
  test("a reviewer who turned the bell off for review requests gets none; another gets one", async () => {
    const t = await newTicket("review", T1);
    const m = await fixtureQuery(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, review_state) VALUES ($1, $2, $3, 'public', 'Try a restart', 'pending') RETURNING id",
      [t.id, P.newbie.id, P.newbie.name]
    );
    await pool().query("INSERT INTO hd_notify_prefs (user_id, prefs) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs", [
      P.lead2.id,
      JSON.stringify({ matrix: { review_requested: { bell: false, push: false, email: false } } }),
    ]);
    try {
      await review.notifyReviewRequested(t.id, m.rows[0].id);
      const bells = async (id: number) =>
        (await pool().query("SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE $2", [id, `%#${t.number} needs review`])).rowCount;
      assert.equal(await bells(P.lead2.id), 0, "matrix honoured");
      assert.equal(await bells(P.lead.id), 1);
    } finally {
      await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [P.lead2.id]);
    }
  });
});

// --- #15 Push and account state -----------------------------------------------------------

describe("#15 Web Push stops with the session and the account", () => {
  const pushed: string[] = [];
  before(() => {
    push.setPushTransportForTests(async (endpoint) => {
      pushed.push(endpoint);
      return { status: 201, text: "" };
    });
  });
  after(() => push.setPushTransportForTests(null));
  const payload = { v: 1 as const, title: "t", body: "b", tag: "x", url: "/desk", ticket: null, silent: false, renotify: true, ts: 0 };

  test("signing a session out drops the device it turned on; sign out everywhere else keeps this one", async () => {
    const a = newToken();
    const b = newToken();
    await createSession(a, P.agent.id, new Date(Date.now() + 3_600_000).toISOString());
    await createSession(b, P.agent.id, new Date(Date.now() + 3_600_000).toISOString());
    await device(P.agent.id, sessionSid(a));
    await device(P.agent.id, sessionSid(b));
    await device(P.agent.id, sessionSid(P.agent.session));
    assert.equal(await deviceCount(P.agent.id), 3);
    await deleteSession(a);
    assert.equal(await deviceCount(P.agent.id), 2);
    await deleteOtherSessions(P.agent.id, P.agent.session);
    const left = (await pool().query("SELECT session_sid FROM hd_push_subscriptions WHERE user_id = $1", [P.agent.id])).rows;
    assert.deepEqual(left.map((r) => r.session_sid), [sessionSid(P.agent.session)]);
  });

  test("a disabled account's devices go, and sending skips anyone no longer on the desk", async () => {
    await device(P.agent2.id, null);
    pushed.length = 0;
    const ok = await push.sendPushToUser(P.agent2.id, payload);
    assert.equal(ok.sent, 1);
    await updateUser(P.agent2.id, { status: "disabled" });
    try {
      assert.equal(await deviceCount(P.agent2.id), 0);
    } finally {
      await updateUser(P.agent2.id, { status: "active" });
    }
    // Not a desk member at all (a requester): nothing is sent, the device goes.
    await device(P.req.id, null);
    pushed.length = 0;
    const r = await push.sendPushToUser(P.req.id, payload);
    assert.equal(r.sent, 0);
    assert.equal(pushed.length, 0);
    assert.equal(await deviceCount(P.req.id), 0);
  });

  test("taking someone off the desk drops their devices", async () => {
    await device(P.fresh.id, null);
    await deskRole(P.fresh.id, "agent");
    await rolesAgents.removeDeskAgent(P.manager, P.fresh.id);
    assert.equal(await deviceCount(P.fresh.id), 0);
  });
});

// --- #16 Built-in key collision ---------------------------------------------------------------

describe("#16 a custom role holding a new built-in's key is moved, never rewritten", () => {
  test("key moves to -custom, name marked, permissions and people kept, audited", async () => {
    const key = `${STAMP}-helpdesk-agent`;
    const r = await fixtureQuery("INSERT INTO roles (key, name, is_builtin) VALUES ($1, 'Helpdesk agent', false) RETURNING id", [key]);
    const id = r.rows[0].id as number;
    roleIds.push(id);
    await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'document.update')", [id]);
    await pool().query("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [id, P.fresh.id]);
    const client = await pool().connect();
    try {
      await moveCustomRoleOffKey(client, key, "Helpdesk agent");
    } finally {
      client.release();
    }
    const row = (await pool().query("SELECT key, name, is_builtin FROM roles WHERE id = $1", [id])).rows[0];
    assert.deepEqual(row, { key: `${key}-custom`, name: "Helpdesk agent (custom)", is_builtin: false });
    assert.equal((await pool().query("SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission = 'document.update'", [id])).rowCount, 1);
    assert.equal((await pool().query("SELECT 1 FROM role_assignments WHERE role_id = $1", [id])).rowCount, 1);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'role.updated' AND target_id = $1", [String(id)])).rows;
    assert.equal(audit.at(-1)?.details.reason, "key_reserved_for_builtin");
    await pool().query("DELETE FROM audit_log WHERE action = 'role.updated' AND target_id = $1", [String(id)]);
  });
});

// --- Digests (#28, #31, #38, #41) --------------------------------------------------------------

describe("digests", () => {
  type Sent = { to: string[]; subject: string; text: string };
  const capture = (box: Sent[]) => async (to: string[], subject: string, text: string) => {
    box.push({ to, subject, text });
  };
  const queued = async (id: number) =>
    (await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM notify_digest_queue WHERE user_id = $1", [id])).rows[0].n;

  test("#28 desk rows wait out the desk's quiet hours; other rows still go", async () => {
    const id = P.manager.id;
    await pool().query("INSERT INTO hd_notify_prefs (user_id, prefs) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs", [
      id,
      JSON.stringify({ quiet: { enabled: true, start: "00:00", end: "00:00", days: [0, 1, 2, 3, 4, 5, 6], breakthrough: false } }),
    ]);
    try {
      await policy.enqueueDigest(id, "desk_assigned_to_me", "digest_hourly", { title: `${STAMP} Assigned #1`, link: "/desk/tickets/1" });
      const box: Sent[] = [];
      const r = await policy.sendNotificationDigests({ now: new Date("2026-11-04T06:10:00Z"), mailer: capture(box), userIds: [id] });
      assert.equal(box.length, 0);
      assert.equal(r.held, 1);
      await policy.enqueueDigest(id, "mention", "digest_hourly", { title: `${STAMP} Mention` });
      await policy.sendNotificationDigests({ now: new Date("2026-11-04T06:20:00Z"), mailer: capture(box), userIds: [id] });
      assert.equal(box.length, 1);
      assert.doesNotMatch(box[0].text, /Assigned #1/);
      assert.equal(await queued(id), 1, "the desk row still waits");
      await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [id]);
      await policy.sendNotificationDigests({ now: new Date("2026-11-04T07:20:00Z"), mailer: capture(box), userIds: [id] });
      assert.equal(box.length, 2);
      assert.match(box[1].text, /Assigned #1/);
    } finally {
      await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [id]);
      await pool().query("DELETE FROM notify_digest_queue WHERE user_id = $1", [id]);
    }
  });

  test("#31 a refused daily digest goes out on the next tick the same day, not tomorrow", async () => {
    const id = P.lead2.id;
    await policy.enqueueDigest(id, "hd_desk_replied", "digest_daily", { title: `${STAMP} Daily` });
    const box: Sent[] = [];
    const refused = await policy.sendNotificationDigests({
      now: new Date("2026-11-04T09:10:00Z"),
      mailer: async () => {
        throw new Error("SMTP 451");
      },
      userIds: [id],
    });
    assert.equal(refused.sent, 0);
    const st = (await pool().query("SELECT last_daily_on FROM notify_digest_state WHERE user_id = $1", [id])).rows[0];
    assert.ok(!st?.last_daily_on, "today is not marked done");
    await policy.sendNotificationDigests({ now: new Date("2026-11-04T10:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 1);
    assert.match(box[0].text, /Daily/);
    assert.equal(await queued(id), 0);
    await pool().query("DELETE FROM notify_digest_state WHERE user_id = $1", [id]);
  });

  test("#38 rows of a sent digest are never sent again (sent_at), even after the stale-claim reset", async () => {
    const id = P.lead2.id;
    await policy.enqueueDigest(id, "mention", "digest_hourly", { title: `${STAMP} Already sent` });
    await pool().query("UPDATE notify_digest_queue SET claimed_at = now() - interval '2 hours', sent_at = now() - interval '2 hours' WHERE user_id = $1", [id]);
    const box: Sent[] = [];
    await policy.sendNotificationDigests({ now: new Date("2026-11-04T06:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 0);
    assert.equal(await queued(id), 0, "cleaned up");
  });

  test("#41 digest links are absolute without a custom domain (the remembered origin)", async () => {
    const id = P.lead2.id;
    hdEmail.rememberOrigin("https://desk.example.test");
    await policy.enqueueDigest(id, "mention", "digest_hourly", { title: `${STAMP} Linked`, link: "/desk/tickets/1047" });
    const box: Sent[] = [];
    await policy.sendNotificationDigests({ now: new Date("2026-11-04T06:10:00Z"), mailer: capture(box), userIds: [id] });
    assert.equal(box.length, 1);
    assert.match(box[0].text, /https?:\/\/[^\s]+\/desk\/tickets\/1047/);
    assert.match(box[0].text, /Change how often these arrive: https?:\/\//);
  });
});

// --- Pure rules (#30, #39, #40, #42) ------------------------------------------------------------

describe("pure rules", () => {
  test("#30 a failed lookup sends only evidence and security mail", () => {
    assert.equal(policy.gateFallback("weekly_digest").send, false);
    assert.equal(policy.gateFallback("doc_update").send, false);
    assert.equal(policy.gateFallback("newsletter").send, false);
    assert.equal(policy.gateFallback("not_an_event").send, false);
    assert.equal(policy.gateFallback("ack_due").send, true);
    assert.equal(policy.gateFallback("security_password").send, true);
  });

  test("#39 an SLA breach email waits for quiet hours when break-through is off", () => {
    const prefs = policyShared.emptyPrefs();
    const d = policyShared.decide("desk_sla_breach", "email", {
      policy: policyShared.resolvePolicy(null),
      prefs,
      timeZone: "UTC",
      now: new Date("2026-11-04T02:00:00Z"),
      urgent: false,
      desk: { matrix: {}, hold: () => "quiet" },
    } as never);
    assert.deepEqual(d, { send: true, mode: "digest_hourly", reason: "quiet_hours" });
    const urgent = policyShared.decide("desk_sla_breach", "email", {
      policy: policyShared.resolvePolicy(null),
      prefs,
      timeZone: "UTC",
      now: new Date("2026-11-04T02:00:00Z"),
      urgent: true,
      desk: { matrix: {}, hold: () => null },
    } as never);
    assert.equal(urgent.mode, "instant");
  });

  test("#40 desk events offer no webhook channel", () => {
    for (const e of policyShared.NOTIFY_EVENTS.filter((x) => x.id.startsWith("desk_"))) {
      assert.equal(e.channels.webhook, undefined, e.id);
    }
  });

  test("#42 business hours default to the workspace zone, else UTC", () => {
    assert.equal(settings.normalizeSettings({}, "America/New_York").timezone, "America/New_York");
    assert.equal(settings.normalizeSettings({}, "Not/AZone").timezone, "UTC");
    assert.equal(settings.normalizeSettings({}).timezone, "UTC");
    assert.equal(settings.normalizeSettings({ timezone: "Asia/Tokyo" }, "America/New_York").timezone, "Asia/Tokyo");
  });
});

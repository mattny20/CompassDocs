// Helpdesk 1.19.0 desk roles (agent J): the default matrix and its
// invariants, the effective-role migration (nobody loses access), the
// assignment limits on Settings → Agents, per-capability 403s, the newbie
// reply review (held, hidden, not emailed, approved with edits, returned
// with a note, by email too) and the audit rows.
//
// Route handlers are called directly with real sessions: next/headers
// resolves to a stub serving the request under test and lib/ee to a stub
// that grants "helpdesk".
//
// Parallel-safe: every team, account and workspace role here is this file's
// own (STAMP); the only shared state it changes is the `helpdesk_role_caps`
// setting, and only under an advisory lock, additively for the roles other
// files' fixtures use, restored to what it was before.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-roles.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-roles.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-roles.virtual.js");
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
const access = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const review = require("../src/lib/helpdesk/review") as typeof import("../src/lib/helpdesk/review");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const agentsRoute = require("../src/app/api/helpdesk/admin/agents/route") as typeof import("../src/app/api/helpdesk/admin/agents/route");
const agentRoute = require("../src/app/api/helpdesk/admin/agents/[userId]/route") as typeof import("../src/app/api/helpdesk/admin/agents/[userId]/route");
const rolesRoute = require("../src/app/api/helpdesk/admin/roles/route") as typeof import("../src/app/api/helpdesk/admin/roles/route");
const reviewsRoute = require("../src/app/api/helpdesk/reviews/route") as typeof import("../src/app/api/helpdesk/reviews/route");
const reviewRoute = require("../src/app/api/helpdesk/reviews/[id]/route") as typeof import("../src/app/api/helpdesk/reviews/[id]/route");
const ticketMessagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdCap, HdRole } from "../src/lib/helpdesk/roles-shared";

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

const URL_BASE = "http://localhost/api/helpdesk";
function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`${URL_BASE}${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdroles-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
  role: "viewer";
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ticketIds: number[] = [];
let T1 = 0;
let T2 = 0;
const mail: { to: string; subject: string; text: string }[] = [];
const notices: { userId: number; event: string; title: string }[] = [];

async function person(key: string, name: string): Promise<Person> {
  const mailAddr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    mailAddr,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  P[key] = { id, session, name, email: mailAddr, role: "viewer" };
  return P[key];
}

/** A workspace role of this file holding exactly `perms`, assigned globally to `userId`. */
async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  if (!perms.length) return;
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  const roleId = r.rows[0].id as number;
  roleIds.push(roleId);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [roleId, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [roleId, userId]);
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query(
    "INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role",
    [userId, role]
  );
}

async function member(teamId: number, userId: number, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [teamId, userId, role]);
}

const settle = () => new Promise((r) => setTimeout(r, 400));

const auditRows = async (action: string, targetId: number | string) =>
  (
    await pool().query<{ actor_id: number; details: Record<string, any> }>(
      "SELECT actor_id, details FROM audit_log WHERE action = $1 AND target_id = $2 AND actor_id = ANY($3) ORDER BY id",
      [action, String(targetId), userIds]
    )
  ).rows;

before(async () => {
  await getSetting("__schema_bootstrap__");
  await pool().query(roles.HD_ROLES_SCHEMA);
  for (const [k, n] of [
    ["newbie", "Nia Newbie"],
    ["agent", "Ari Agent"],
    ["lead", "Lena Lead"],
    ["manager", "Milo Manager"],
    ["admin", "Ada Admin"],
    ["wsadmin", "Wes Workspace"],
    ["req", "Rae Requester"],
    ["x", "Xan Fresh"],
    ["other", "Oli Otherteam"],
  ] as const) {
    await person(k, n);
  }
  const t1 = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9001) RETURNING id", [`${STAMP} IT`]);
  T1 = t1.rows[0].id;
  const t2 = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9002) RETURNING id", [`${STAMP} HR`]);
  T2 = t2.rows[0].id;
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.agent.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.manager.id, "manager");
  await deskRole(P.admin.id, "admin");
  await deskRole(P.other.id, "agent");
  await member(T1, P.newbie.id);
  await member(T1, P.agent.id);
  await member(T1, P.lead.id, "lead");
  await member(T2, P.other.id);
  await grant(P.wsadmin.id, ["helpdesk.admin", "helpdesk.request"], "wsadmin");
  await grant(P.req.id, ["helpdesk.request"], "req");
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push({ to: m.to, subject: m.subject, text: m.text });
  });
  review.setReviewNoticeSpyForTests((userId, event, title) => notices.push({ userId, event, title }));
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  review.setReviewNoticeSpyForTests(null);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR id = ANY($3)", [[T1, T2], userIds, ticketIds])).rows.map(
    (r) => r.id
  );
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- The default matrix ----------------------------------------------------------------

describe("default matrix", () => {
  const has = (r: HdRole, c: HdCap) => shared.HD_DEFAULT_MATRIX[r].includes(c);

  test("the five roles, labelled", () => {
    assert.deepEqual([...shared.HD_ROLES], ["newbie", "agent", "team_lead", "manager", "admin"]);
    assert.deepEqual(Object.values(shared.HD_ROLE_LABEL), ["Newbie", "Agent", "Team lead", "Manager", "Admin"]);
  });

  test("Newbie: own queues, replies held for review, notes, take, macros, own stats; nothing else", () => {
    assert.deepEqual(
      [...shared.HD_DEFAULT_MATRIX.newbie].sort(),
      ["macros.use", "reports.own", "tickets.assign_self", "tickets.internal_note", "tickets.reply_needs_review", "tickets.view_team"].sort()
    );
  });

  test("Agent: newbie + direct replies, status, priority, transfer, personal macros", () => {
    for (const c of ["tickets.reply_public", "tickets.change_status", "tickets.change_priority", "tickets.transfer_team", "macros.manage_personal"] as HdCap[]) {
      assert.ok(has("agent", c), c);
    }
    for (const c of ["tickets.reply_needs_review", "tickets.assign_team", "tickets.delete", "tickets.export", "replies.review"] as HdCap[]) assert.ok(!has("agent", c), c);
  });

  test("merge and bulk are not capabilities in 1.19.0; a stored override naming them is harmless", () => {
    assert.equal(shared.isHdCap("tickets.merge"), false);
    assert.equal(shared.isHdCap("tickets.bulk"), false);
    assert.ok(!shared.HD_CAP_KEYS.some((k) => /merge|bulk/.test(k)), "not in the catalog the Roles page shows");
    const m = shared.resolveMatrix({ agent: [...shared.HD_DEFAULT_MATRIX.agent, "tickets.merge", "tickets.bulk"] });
    assert.deepEqual(m.agent, shared.HD_DEFAULT_MATRIX.agent, "dropped on read");
    assert.ok(!m.admin.some((k) => /merge|bulk/.test(k)));
  });

  test("Team lead: agent + assign in team, review, team macros and reports, people in team, SLA override", () => {
    for (const c of ["tickets.assign_team", "replies.review", "macros.manage_team", "reports.team", "agents.manage_team", "tickets.sla_override"] as HdCap[]) {
      assert.ok(has("team_lead", c), c);
    }
    for (const c of shared.HD_DEFAULT_MATRIX.agent) assert.ok(has("team_lead", c), `inherits ${c}`);
    assert.ok(!has("team_lead", "tickets.view_all"));
    assert.ok(!has("team_lead", "agents.assign_roles"));
  });

  test("Manager: all teams, reports, export, configuration, teams, roles up to lead; not channels/templates/settings/matrix/delete", () => {
    for (const c of [
      "tickets.view_all",
      "tickets.export",
      "reports.all",
      "sla.manage",
      "automations.manage",
      "macros.manage_all",
      "request_types.manage",
      "workflows.manage",
      "csat.manage",
      "teams.manage",
      "agents.assign_roles",
    ] as HdCap[]) {
      assert.ok(has("manager", c), c);
    }
    for (const c of ["channels.manage", "templates.manage", "settings.manage", "roles.manage", "tickets.delete"] as HdCap[]) assert.ok(!has("manager", c), c);
    assert.deepEqual(shared.assignableRolesFor("manager", shared.HD_DEFAULT_MATRIX.manager), ["newbie", "agent", "team_lead"]);
  });

  test("Admin: every capability; assigns any role", () => {
    assert.deepEqual(shared.HD_DEFAULT_MATRIX.admin, shared.HD_CAP_KEYS);
    assert.deepEqual(shared.assignableRolesFor("admin", shared.HD_DEFAULT_MATRIX.admin), [...shared.HD_ROLES]);
    assert.deepEqual(shared.assignableRolesFor("team_lead", shared.HD_DEFAULT_MATRIX.team_lead), ["newbie", "agent"]);
    assert.deepEqual(shared.assignableRolesFor("agent", shared.HD_DEFAULT_MATRIX.agent), []);
  });

  test("every default holds the invariants", () => {
    for (const r of shared.HD_ROLES) {
      const caps = shared.HD_DEFAULT_MATRIX[r];
      assert.ok(!(caps.includes("tickets.reply_public") && caps.includes("tickets.reply_needs_review")) || r === "admin", r);
      if (shared.HD_ROLE_RANK[r] < shared.HD_ROLE_RANK.manager) {
        for (const c of shared.HD_MANAGER_ONLY_CAPS) assert.ok(!caps.includes(c), `${r} ${c}`);
      }
    }
  });
});

describe("matrix invariants (checkMatrix, resolveMatrix)", () => {
  const D = shared.HD_DEFAULT_MATRIX;
  const adminEd = { role: "admin" as HdRole, caps: shared.HD_CAP_KEYS };
  const managerEd = { role: "manager" as HdRole, caps: [...D.manager, "roles.manage"] as HdCap[] };

  test("Admin's column can't be changed; it is always everything", () => {
    const r = shared.checkMatrix({ admin: [] }, D, adminEd);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.changed, []);
    assert.deepEqual(shared.resolveMatrix({ admin: ["tickets.view_team"] }).admin, shared.HD_CAP_KEYS);
  });

  test("roles.manage and agents.assign_roles stay with Managers", () => {
    const r = shared.checkMatrix({ team_lead: [...D.team_lead, "roles.manage"] }, D, adminEd);
    assert.equal(r.ok, false);
    assert.equal(shared.resolveMatrix({ agent: [...D.agent, "agents.assign_roles"] }).agent.includes("agents.assign_roles"), false, "stripped on read too");
    assert.ok(shared.checkMatrix({ manager: [...D.manager, "roles.manage"] }, D, adminEd).ok);
  });

  test("direct replies and replies after review are exclusive", () => {
    const r = shared.checkMatrix({ newbie: [...D.newbie, "tickets.reply_public"] }, D, adminEd);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /can't both be on/);
  });

  test("nobody grants or removes a capability they don't hold, or changes a role at or above their own", () => {
    const grantChannels = shared.checkMatrix({ agent: [...D.agent, "channels.manage"] }, D, managerEd);
    assert.equal(grantChannels.ok, false);
    const ownColumn = shared.checkMatrix({ manager: D.manager.filter((c) => c !== "csat.manage") }, D, managerEd);
    assert.equal(ownColumn.ok, false);
    const fine = shared.checkMatrix({ newbie: D.newbie.filter((c) => c !== "macros.use") }, D, managerEd);
    assert.ok(fine.ok);
    assert.deepEqual(fine.ok && fine.changed, ["newbie"]);
    assert.equal(shared.checkMatrix({ newbie: ["nope"] }, D, adminEd).ok, false, "unknown capability");
    assert.equal(shared.checkMatrix({ boss: [] }, D, adminEd).ok, false, "unknown role");
  });

  test("overrides store only what differs", () => {
    const m = { ...D, agent: [...D.agent, "tickets.export"] as HdCap[] };
    const o = shared.toOverrides(m);
    assert.deepEqual(Object.keys(o), ["agent"]);
    assert.deepEqual(shared.resolveMatrix(o).agent, shared.resolveMatrix(o).agent.filter((c) => m.agent.includes(c)));
    assert.deepEqual(shared.resolveMatrix(null), D);
    assert.deepEqual(shared.resolveMatrix("garbage"), D);
  });
});

// --- Effective role: the migration -------------------------------------------------------

describe("effective role: every pre-1.19 permission combination keeps its access", () => {
  const KEYS = ["helpdesk.agent", "helpdesk.agent_all", "helpdesk.admin", "helpdesk.reports"] as const;
  interface Combo {
    mask: number;
    lead: boolean;
    user: Person;
  }
  const combos: Combo[] = [];

  before(async () => {
    for (let mask = 0; mask < 16; mask++) {
      for (const lead of [false, true]) {
        const u = await person(`c${mask}${lead ? "l" : ""}`, `Combo ${mask}${lead ? " lead" : ""}`);
        await grant(
          u.id,
          KEYS.filter((_, i) => mask & (1 << i)),
          `c${mask}${lead ? "l" : ""}`
        );
        await member(T1, u.id, lead ? "lead" : "agent");
        combos.push({ mask, lead, user: u });
      }
    }
  });

  // What access.ts answered before the ladder, from the workspace keys alone.
  function old(mask: number) {
    const agent = Boolean(mask & 1);
    const agentAll = Boolean(mask & 2);
    const admin = Boolean(mask & 4);
    const reports = Boolean(mask & 8);
    const isAgent = agent || agentAll;
    const teams: number[] | "all" = agentAll ? "all" : agent ? [T1] : [];
    return { isAgent, agentAll, admin, reports: reports || admin, teams };
  }

  test("derived roles", async () => {
    const expect = (mask: number, lead: boolean): HdRole | null => {
      if (mask & 4) return "admin";
      if (mask & 2 && mask & 8) return "manager";
      if (mask & 3) return lead ? "team_lead" : "agent";
      return null;
    };
    for (const c of combos) {
      const r = await roles.hdRoleOf(c.user);
      assert.equal(r?.role ?? null, expect(c.mask, c.lead), `mask ${c.mask} lead ${c.lead}`);
      if (r) assert.equal(r.source, c.mask & 4 ? "workspace" : "derived");
    }
  });

  test("isAgent / hasAgentAll / isHelpdeskAdmin / canReadReports / agentTeamIds / canWorkTicket match (Admin only widens)", async () => {
    const tIn = { id: 1, requester_id: null, team_id: T1, assignee_id: null };
    const tOut = { id: 2, requester_id: null, team_id: T2, assignee_id: null };
    for (const c of combos) {
      const o = old(c.mask);
      const tMine = { id: 3, requester_id: null, team_id: T2, assignee_id: c.user.id };
      const now = {
        isAgent: await access.isAgent(c.user),
        agentAll: await access.hasAgentAll(c.user),
        admin: await access.isHelpdeskAdmin(c.user),
        reports: await access.canReadReports(c.user),
        teams: await access.agentTeamIds(c.user),
        workIn: await access.canWorkTicket(c.user, tIn),
        workOut: await access.canWorkTicket(c.user, tOut),
        workMine: await access.canWorkTicket(c.user, tMine),
      };
      const label = `mask ${c.mask} lead ${c.lead}`;
      const oldWork = (t: { team_id: number; assignee_id: number | null }) =>
        o.teams === "all" || (o.isAgent && (t.assignee_id === c.user.id || o.teams.includes(t.team_id)));
      if (c.mask & 4) {
        // A workspace helpdesk.admin holder is desk Admin: everything.
        assert.deepEqual(now, { isAgent: true, agentAll: true, admin: true, reports: true, teams: "all", workIn: true, workOut: true, workMine: true }, label);
        continue;
      }
      assert.equal(now.isAgent, o.isAgent, `${label} isAgent`);
      assert.equal(now.agentAll, o.agentAll, `${label} agentAll`);
      assert.equal(now.admin, o.admin, `${label} admin`);
      assert.equal(now.reports, o.reports, `${label} reports`);
      assert.deepEqual(now.teams, o.teams, `${label} teams`);
      assert.equal(now.workIn, oldWork(tIn), `${label} work in team`);
      assert.equal(now.workOut, oldWork(tOut), `${label} work other team`);
      assert.equal(now.workMine, oldWork(tMine), `${label} work assigned`);
    }
  });

  test("helpdeskCapabilities keeps its shape and answers", async () => {
    const c = combos.find((x) => x.mask === 1 && !x.lead)!;
    const { request: _request, ...caps } = await access.helpdeskCapabilities(c.user);
    assert.deepEqual(caps, {
      licensed: true,
      agent: true,
      agent_all: false,
      admin: false,
      reports: false,
    });
  });

  test("an assigned desk role grants desk entry without helpdesk.agent; the workspace Admin floor can't be lowered", async () => {
    assert.equal(await access.isAgent(P.newbie), true);
    assert.deepEqual(await access.agentTeamIds(P.newbie), [T1]);
    await deskRole(P.wsadmin.id, "newbie");
    try {
      const r = await roles.hdRoleOf(P.wsadmin.id);
      assert.deepEqual(r, { role: "admin", source: "workspace" });
      const caps = await roles.hdCapsFor(P.wsadmin);
      assert.equal(caps.role_label, "Admin (from workspace role)");
      assert.equal(caps.locked, true);
    } finally {
      await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.wsadmin.id]);
    }
  });

  test("leadTeamIds derives from the desk role", async () => {
    assert.deepEqual(await access.leadTeamIds(P.lead.id), [T1]);
    assert.deepEqual(await access.leadTeamIds(P.agent.id), []);
    const derivedLead = combos.find((x) => x.mask === 1 && x.lead)!;
    assert.deepEqual(await access.leadTeamIds(derivedLead.user.id), [T1]);
  });
});

// --- Capabilities, enforced ----------------------------------------------------------------

describe("each capability is enforced (403) for a role lacking it", () => {
  test("hdCapGate admits exactly the roles whose defaults hold the capability", async () => {
    const byRole: Record<HdRole, Person> = { newbie: P.newbie, agent: P.agent, team_lead: P.lead, manager: P.manager, admin: P.admin };
    for (const cap of shared.HD_CAP_KEYS) {
      for (const r of shared.HD_ROLES) {
        currentRequest = req("/x", byRole[r].session);
        try {
          const g = await roles.hdCapGate(cap);
          const ok = !(g instanceof Response);
          assert.equal(ok, shared.HD_DEFAULT_MATRIX[r].includes(cap), `${r} ${cap}`);
          if (!ok) assert.equal((g as Response).status, 403, `${r} ${cap}`);
        } finally {
          currentRequest = null;
        }
      }
    }
  });

  test("team-scoped capabilities apply in the person's teams only, unless lifted", async () => {
    assert.equal(await roles.hdCan(P.lead, "tickets.assign_team", { teamId: T1 }), true);
    assert.equal(await roles.hdCan(P.lead, "tickets.assign_team", { teamId: T2 }), false);
    assert.equal(await roles.hdCan(P.lead, "replies.review", { teamId: T2 }), false);
    assert.equal(await roles.hdCan(P.manager, "replies.review", { teamId: T2 }), true, "Managers work every team");
    assert.equal(await roles.hdCan(P.agent, "tickets.change_priority", { teamId: T2 }), false);
    assert.equal(await roles.hdCan(P.lead, "agents.manage_team", { teamId: T2 }), false);
    assert.equal(await roles.hdCan(P.manager, "agents.manage_team", { teamId: T2 }), true, "teams.manage lifts it");
  });

  test("my routes refuse roles without the capability", async () => {
    assert.equal((await call(agentsRoute.GET, req("/admin/agents", P.newbie.session))).status, 403);
    assert.equal((await call(agentsRoute.GET, req("/admin/agents", P.agent.session))).status, 403);
    assert.equal((await call(agentsRoute.GET, req("/admin/agents", P.lead.session))).status, 200);
    assert.equal((await call(agentsRoute.POST, req("/admin/agents", P.agent.session, { user_id: P.x.id, role: "newbie", team_ids: [T1] }))).status, 403);
    for (const who of [P.newbie, P.agent, P.lead, P.manager]) {
      assert.equal((await call(rolesRoute.GET, req("/admin/roles", who.session))).status, 403, who.name);
      assert.equal((await call(rolesRoute.PUT, req("/admin/roles", who.session, { matrix: {} }, "PUT"))).status, 403, who.name);
      assert.equal((await call(rolesRoute.POST, req("/admin/roles", who.session, {}))).status, 403, who.name);
    }
    assert.equal((await call(reviewsRoute.GET, req("/reviews", P.agent.session))).status, 403);
    assert.equal((await call(reviewsRoute.GET, req("/reviews", P.newbie.session))).status, 403);
    assert.equal((await call(reviewRoute.POST, req("/reviews/1", P.newbie.session, { decision: "approve" }), { id: "1" })).status, 403);
    assert.equal((await call(agentsRoute.GET, req("/admin/agents", P.req.session))).status, 403, "a requester");
  });

  test("unlicensed: 402", async () => {
    edition.features = [];
    try {
      assert.equal((await call(agentsRoute.GET, req("/admin/agents", P.admin.session))).status, 402);
      assert.equal((await call(reviewsRoute.GET, req("/reviews", P.lead.session))).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});

// --- Assignment limits ---------------------------------------------------------------------

describe("assigning desk roles", () => {
  const patch = (by: Person, userId: number, body: unknown) => call(agentRoute.PATCH, req(`/admin/agents/${userId}`, by.session, body, "PATCH"), { userId: String(userId) });
  const del = (by: Person, userId: number) => call(agentRoute.DELETE, req(`/admin/agents/${userId}`, by.session, undefined, "DELETE"), { userId: String(userId) });
  const teamRow = async (userId: number) => (await pool().query("SELECT team_id, role FROM hd_team_members WHERE user_id = $1 ORDER BY team_id", [userId])).rows;

  test("a team lead adds a newbie to their own team, not elsewhere, and can't make a manager", async () => {
    assert.equal((await call(agentsRoute.POST, req("/admin/agents", P.lead.session, { user_id: P.x.id, role: "manager", team_ids: [T1] }))).status, 403);
    assert.equal((await call(agentsRoute.POST, req("/admin/agents", P.lead.session, { user_id: P.x.id, role: "team_lead", team_ids: [T1] }))).status, 403);
    assert.equal((await call(agentsRoute.POST, req("/admin/agents", P.lead.session, { user_id: P.x.id, role: "newbie", team_ids: [T2] }))).status, 403);
    assert.equal((await call(agentsRoute.POST, req("/admin/agents", P.lead.session, { user_id: P.x.id, role: "newbie" }))).status, 400, "needs a team");
    const ok = await call(agentsRoute.POST, req("/admin/agents", P.lead.session, { user_id: P.x.id, role: "newbie", team_ids: [T1] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.agent.role, "newbie");
    assert.deepEqual(await teamRow(P.x.id), [{ team_id: T1, role: "agent" }]);
    const a = await auditRows("helpdesk.agent_role.assigned", P.x.id);
    assert.equal(a.length, 1);
    assert.equal(a[0].details.role, "newbie");
    assert.equal((await call(agentsRoute.POST, req("/admin/agents", P.lead.session, { user_id: P.x.id, role: "agent", team_ids: [T1] }))).status, 409, "already on the desk");
  });

  test("a team lead moves a newbie up to agent, but can't touch other teams' people or a lead", async () => {
    const up = await patch(P.lead, P.x.id, { role: "agent" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.agent.role, "agent");
    assert.equal((await auditRows("helpdesk.agent_role.changed", P.x.id)).length, 1);
    assert.equal((await patch(P.lead, P.other.id, { role: "newbie" })).status, 403, "other team");
    assert.equal((await patch(P.lead, P.lead.id, { role: "agent" })).status, 403, "self");
    assert.equal((await patch(P.lead, P.manager.id, { role: "agent" })).status, 403, "above");
  });

  test("a manager makes a team lead (hd_team_members follows), not an admin, and can't change an admin or themselves", async () => {
    const r = await patch(P.manager, P.x.id, { role: "team_lead" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await teamRow(P.x.id), [{ team_id: T1, role: "lead" }]);
    assert.deepEqual(await access.leadTeamIds(P.x.id), [T1]);
    assert.equal((await patch(P.manager, P.x.id, { role: "admin" })).status, 403);
    assert.equal((await patch(P.manager, P.x.id, { role: "manager" })).status, 403, "only below their own");
    assert.equal((await patch(P.manager, P.admin.id, { role: "agent" })).status, 403);
    assert.equal((await patch(P.manager, P.manager.id, { role: "agent" })).status, 403);
    // Teams: a manager moves people between any teams.
    const moved = await patch(P.manager, P.x.id, { team_ids: [T1, T2] });
    assert.equal(moved.status, 200);
    assert.deepEqual(await teamRow(P.x.id), [
      { team_id: T1, role: "lead" },
      { team_id: T2, role: "lead" },
    ]);
  });

  test("a workspace Admin can't be changed in the desk", async () => {
    const r = await patch(P.admin, P.wsadmin.id, { role: "agent" });
    assert.equal(r.status, 409);
    const list = await call(agentsRoute.GET, req("/admin/agents", P.admin.session));
    const row = list.body.agents.find((a: any) => a.user_id === P.wsadmin.id);
    assert.equal(row.role_label, "Admin (from workspace role)");
    assert.equal(row.locked, true);
    assert.equal(row.manageable, false);
  });

  test("the admin promotes to manager; a lead can't remove them; the admin removes them from the desk", async () => {
    assert.equal((await patch(P.admin, P.x.id, { role: "manager" })).status, 200);
    assert.deepEqual(await teamRow(P.x.id), [
      { team_id: T1, role: "agent" },
      { team_id: T2, role: "agent" },
    ], "a Manager is not a lead in hd_team_members");
    assert.equal((await del(P.lead, P.x.id)).status, 403);
    const r = await del(P.admin, P.x.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.role_removed, true);
    assert.deepEqual(await teamRow(P.x.id), []);
    assert.equal(await roles.hdRoleOf(P.x.id), null);
    assert.equal((await auditRows("helpdesk.agent_role.removed", P.x.id)).length, 1);
  });

  test("a team lead removes a newbie from their team only", async () => {
    await deskRole(P.x.id, "newbie");
    await member(T1, P.x.id);
    await member(T2, P.x.id);
    const r = await del(P.lead, P.x.id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.removed_team_ids, [T1]);
    assert.equal(r.body.role_removed, false, "still in another team");
    assert.deepEqual(await teamRow(P.x.id), [{ team_id: T2, role: "agent" }]);
    await pool().query("DELETE FROM hd_team_members WHERE user_id = $1", [P.x.id]);
    await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.x.id]);
  });

  test("the list counts roles and marks what the caller may change", async () => {
    const r = await call(agentsRoute.GET, req("/admin/agents", P.lead.session));
    assert.equal(r.status, 200);
    const mine = r.body.agents.filter((a: any) => userIds.includes(a.user_id));
    const row = (id: number) => mine.find((a: any) => a.user_id === id);
    assert.equal(row(P.newbie.id).manageable, true);
    assert.equal(row(P.other.id).manageable, false, "another team");
    assert.equal(row(P.manager.id).manageable, false, "above");
    assert.deepEqual(r.body.me.assignable_roles, ["newbie", "agent"]);
    for (const k of shared.HD_ROLES) assert.equal(typeof r.body.counts[k], "number");
  });
});

// --- The matrix, edited (shared setting: advisory lock + restore) -----------------------------

describe("editing the matrix", () => {
  const LOCK = 728371; // helpdesk_role_caps
  let lockClient: import("pg").PoolClient | null = null;
  let saved: string | undefined;

  before(async () => {
    lockClient = await pool().connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
    saved = await getSetting(roles.HD_ROLE_CAPS_KEY);
    await pool().query("DELETE FROM settings WHERE key = $1", [roles.HD_ROLE_CAPS_KEY]);
    roles.clearRoleMatrixCache();
  });

  after(async () => {
    if (saved === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [roles.HD_ROLE_CAPS_KEY]);
    else await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [roles.HD_ROLE_CAPS_KEY, saved]);
    roles.clearRoleMatrixCache();
    await lockClient?.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    lockClient?.release();
  });

  const D = shared.HD_DEFAULT_MATRIX;
  const put = (by: Person, matrix: unknown) => call(rolesRoute.PUT, req("/admin/roles", by.session, { matrix }, "PUT"));

  test("the admin reads the matrix with the reasons cells are locked", async () => {
    const r = await call(rolesRoute.GET, req("/admin/roles", P.admin.session));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.matrix, D);
    assert.equal(r.body.locks.admin["tickets.view_team"], "Admin always has every capability.");
    assert.equal(r.body.locks.team_lead["roles.manage"], "Only Managers and Admins can hold this.");
    assert.equal(r.body.locks.agent["tickets.export"], null);
  });

  test("the admin grants Agent export; it takes effect; invariants are refused server-side", async () => {
    const r = await put(P.admin, { agent: [...D.agent, "tickets.export"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await roles.hdCan(P.agent, "tickets.export"), true);
    const a = await auditRows("helpdesk.roles.updated", "matrix");
    assert.deepEqual(a.at(-1)!.details.changes, { agent: { added: ["tickets.export"], removed: [] } });
    assert.equal((await put(P.admin, { team_lead: [...D.team_lead, "agents.assign_roles"] })).status, 400);
    assert.equal((await put(P.admin, { newbie: [...D.newbie, "tickets.reply_public"] })).status, 400);
    const adminCol = await put(P.admin, { admin: [] });
    assert.equal(adminCol.status, 200);
    assert.deepEqual(adminCol.body.matrix.admin, shared.HD_CAP_KEYS);
  });

  test("a manager given roles.manage edits roles below them, only with capabilities they hold", async () => {
    assert.equal((await put(P.admin, { manager: [...D.manager, "roles.manage"] })).status, 200);
    assert.equal((await put(P.manager, { agent: [...D.agent, "tickets.export", "channels.manage"] })).status, 400, "channels: not theirs");
    assert.equal((await put(P.manager, { manager: D.manager })).status, 400, "own column");
    assert.equal((await put(P.manager, { team_lead: [...D.team_lead, "tickets.delete"] })).status, 400, "delete: not theirs");
    const ok = await put(P.manager, { team_lead: [...D.team_lead, "tickets.export"] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("Reset to defaults", async () => {
    const r = await call(rolesRoute.POST, req("/admin/roles", P.admin.session, {}));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.matrix, D);
    assert.equal(await roles.hdCan(P.agent, "tickets.export"), false);
    assert.equal((await auditRows("helpdesk.roles.reset", "matrix")).length, 1);
  });
});

// --- Newbie reply review -------------------------------------------------------------------

describe("newbie reply review", () => {
  let ticket: { id: number; number: number };

  before(async () => {
    const t = await tickets.createTicket(
      {
        subject: `${STAMP} printer jam`,
        body: "The second-floor printer jams on every job.",
        requester: { id: P.req.id, name: P.req.name, email: P.req.email },
        team_id: T1,
      } as never,
      { silent: true, actorId: P.req.id, actorName: P.req.name }
    );
    ticketIds.push(t.id);
    ticket = { id: t.id, number: t.number };
  });

  const post = (by: Person, body: unknown) =>
    call(ticketMessagesRoute.POST, req(`/tickets/${ticket.number}/messages`, by.session, body), { number: String(ticket.number) });
  const requesterView = async () => {
    const r = await call(requestRoute.GET, req(`/requests/${ticket.number}`, P.req.session), { number: String(ticket.number) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.request.messages as { body: string; kind: string }[];
  };
  const row = async (id: number) => (await pool().query("SELECT * FROM hd_messages WHERE id = $1", [id])).rows[0];
  let pendingId = 0;

  test("a newbie's public reply is held: pending, hidden from the requester, not emailed, no first reply", async () => {
    mail.length = 0;
    notices.length = 0;
    const r = await post(P.newbie, { kind: "public", body: "Hi Rae, try turning it off and on again." });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    pendingId = r.body.message.id;
    assert.equal((await row(pendingId)).review_state, "pending");
    await settle();
    assert.ok(!(await requesterView()).some((m) => m.body.includes("off and on")), "hidden from the requester");
    assert.ok(!mail.some((m) => m.text.includes("off and on")), "not emailed");
    const t = (await pool().query("SELECT first_replied_at, status FROM hd_tickets WHERE id = $1", [ticket.id])).rows[0];
    assert.equal(t.first_replied_at, null);
    assert.equal(t.status, "new");
    assert.ok(notices.some((n) => n.userId === P.lead.id && n.event === "desk_review_requested"), "the team lead is asked");
    assert.ok(!notices.some((n) => n.userId === P.manager.id), "managers only when the team has no lead");
  });

  test("an agent's reply is sent straight away (no review)", async () => {
    const r = await post(P.agent, { kind: "internal", body: "Toner is low too." });
    assert.equal(r.status, 201);
    assert.equal((await row(r.body.message.id)).review_state, null);
  });

  test("the lead sees it in Reviews; the newbie and agents can't decide it", async () => {
    const list = await call(reviewsRoute.GET, req("/reviews", P.lead.session));
    assert.equal(list.status, 200);
    assert.ok(list.body.reviews.some((v: any) => v.message_id === pendingId && v.ticket_number === ticket.number));
    const otherLead = await call(reviewsRoute.GET, req("/reviews", P.manager.session));
    assert.ok(otherLead.body.reviews.some((v: any) => v.message_id === pendingId), "managers see every team's");
    assert.equal((await call(reviewRoute.POST, req(`/reviews/${pendingId}`, P.agent.session, { decision: "approve" }), { id: String(pendingId) })).status, 403);
  });

  test("approve with edits sends the edited text, by email too, and stamps the first reply", async () => {
    mail.length = 0;
    const r = await call(
      reviewRoute.POST,
      req(`/reviews/${pendingId}`, P.lead.session, { decision: "approve", edited_body: "Hi Rae, we've cleared the jam. Try printing again." }),
      { id: String(pendingId) }
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.review.edited, true);
    const m = await row(pendingId);
    assert.equal(m.review_state, "approved");
    assert.equal(m.reviewed_by, P.lead.id);
    const view = await requesterView();
    assert.ok(view.some((x) => x.body === "Hi Rae, we've cleared the jam. Try printing again."));
    assert.ok(!view.some((x) => x.body.includes("off and on")));
    await settle();
    assert.ok(mail.some((x) => x.to === P.req.email && x.text.includes("cleared the jam")), "emailed to the requester");
    const t = (await pool().query("SELECT first_replied_at, status FROM hd_tickets WHERE id = $1", [ticket.id])).rows[0];
    assert.ok(t.first_replied_at);
    assert.equal(t.status, "open");
    const a = await auditRows("helpdesk.reply.reviewed", pendingId);
    assert.equal(a.length, 1);
    assert.equal(a[0].details.decision, "approve");
    assert.equal(a[0].details.edited, true);
    assert.equal((await call(reviewRoute.POST, req(`/reviews/${pendingId}`, P.lead.session, { decision: "approve" }), { id: String(pendingId) })).status, 409);
  });

  test("return needs a note; it stays hidden, the note lands as an internal message, the newbie is told", async () => {
    notices.length = 0;
    const r = await post(P.newbie, { kind: "public", body: "It's probably broken, sorry." });
    const id = r.body.message.id as number;
    assert.equal((await call(reviewRoute.POST, req(`/reviews/${id}`, P.lead.session, { decision: "return" }), { id: String(id) })).status, 400);
    const ret = await call(reviewRoute.POST, req(`/reviews/${id}`, P.lead.session, { decision: "return", note: "Offer the loan printer on 3." }), { id: String(id) });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    const m = await row(id);
    assert.equal(m.review_state, "returned");
    assert.equal(m.review_note, "Offer the loan printer on 3.");
    assert.ok(!(await requesterView()).some((x) => x.body.includes("probably broken")));
    const internal = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' ORDER BY id DESC LIMIT 1", [ticket.id])).rows[0];
    assert.match(internal.body, /Offer the loan printer on 3\./);
    assert.ok(notices.some((n) => n.userId === P.newbie.id && n.event === "desk_review_returned"));
    assert.equal((await auditRows("helpdesk.reply.reviewed", id))[0].details.decision, "return");
  });

  test("a newbie's emailed reply is held too", async () => {
    const token = await email.ensureReplyToken(ticket.id);
    assert.ok(token);
    mail.length = 0;
    const res = await inbound.processInboundEmail(
      {
        provider: "generic",
        from: { email: P.newbie.email, name: P.newbie.name },
        to: [{ email: "help@example.test", name: "" }],
        cc: [],
        recipients: [],
        subject: `Re: ${STAMP} printer jam [#${ticket.number} ref:${token}]`,
        text: "Replying from my phone: the engineer comes at 3.",
        html: "",
        stripped: "",
        messageId: `${newToken()}@mail.example.test`,
        inReplyTo: "",
        references: [],
        headers: {},
        // The provider's verdict: the sender's domain passed DMARC (an
        // unverified From is an outside sender since the 1.19.0 review).
        auth: { dmarc: "pass" },
        files: [],
      } as never,
      { outsideSenders: false }
    );
    assert.equal(res.body.outcome, "appended", JSON.stringify(res.body));
    const last = (await pool().query("SELECT review_state, body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id DESC LIMIT 1", [ticket.id])).rows[0];
    assert.match(last.body, /engineer comes at 3/);
    assert.equal(last.review_state, "pending");
    await settle();
    assert.ok(!mail.some((m) => m.text.includes("engineer comes at 3")), "not emailed");
    assert.ok(!(await requesterView()).some((x) => x.body.includes("engineer comes at 3")));
  });

  test("with no team lead, managers are asked", async () => {
    const to = await review.reviewersFor(T2, P.other.id);
    assert.ok(to.includes(P.manager.id) && to.includes(P.admin.id));
    assert.ok(!to.includes(P.lead.id));
  });
});

// Helpdesk agent allowances (the licence's `agents` claim): who counts, the
// hard block in setDeskAgent (Settings → Agents → Add agent, and a role for
// someone not yet on the desk), its 402 body and audit row, the role change
// that is never blocked, two adds at once that can't both take the last
// place, and the paths that are never blocked (RBAC assignRole) showing up
// as "over" on the listing instead.
//
// Route handlers are called directly with real sessions: next/headers
// resolves to a stub serving the request under test, lib/ee to a stub that
// grants "helpdesk", and lib/license to the real module with
// agentAllowance() and agentLimit() answering what each test sets (so no
// key is signed and the shared `license_key` setting is never touched).
//
// Parallel-safe: every account, team and workspace role here is this file's
// own (STAMP). The count is global (other files' agents count too), so a
// limit is set either far below it (1, with this file's own agents always
// counted) or relative to it, re-run if another file changed the desk
// meanwhile.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-agent-limit.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, assignRole } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next, the licensed edition, the allowance ---------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

/** What agentAllowance() answers: null = unlimited. */
let allowance: number | null = null;
/** The key's own number agentLimit() reports; undefined = the same as `allowance` (an active licence). */
let licensedOverride: number | null | undefined = undefined;

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-agent-limit.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-agent-limit.virtual.js");
const LICENSE_STUB = path.join(__dirname, "stubs", "license.helpdesk-agent-limit.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const LICENSE_REAL = path.join(__dirname, "..", "src", "lib", "license");
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
  const edition = { present: true, features: ["helpdesk"] };
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  // The real licence module (loaded before the hook below), with the allowance this file sets.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require(LICENSE_REAL) as typeof import("../src/lib/license");
  const license = new Module(LICENSE_STUB);
  license.filename = LICENSE_STUB;
  license.loaded = true;
  license.exports = {
    ...real,
    agentAllowance: async () => allowance,
    agentLimit: async () => ({ allowed: allowance, licensed: licensedOverride === undefined ? allowance : licensedOverride }),
  };
  require.cache[LICENSE_STUB] = license;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  const relativeTo = (request: string, parent: { filename?: string } | null, real: string) =>
    request.startsWith(".") && !!parent?.filename && path.resolve(path.dirname(parent.filename), request) === real;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee" || relativeTo(request, parent, EE_REAL)) return EE_STUB;
    if (request === "@/lib/license" || relativeTo(request, parent, LICENSE_REAL)) return LICENSE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const agentsLib = require("../src/lib/helpdesk/roles-agents") as typeof import("../src/lib/helpdesk/roles-agents");
const seed = require("../src/lib/helpdesk/seed") as typeof import("../src/lib/helpdesk/seed");
const agentsRoute = require("../src/app/api/helpdesk/admin/agents/route") as typeof import("../src/app/api/helpdesk/admin/agents/route");
const agentRoute = require("../src/app/api/helpdesk/admin/agents/[userId]/route") as typeof import("../src/app/api/helpdesk/admin/agents/[userId]/route");
const licenseRoute = require("../src/app/api/admin/license/route") as typeof import("../src/app/api/admin/license/route");
const diagnostics = require("../src/lib/diagnostics") as typeof import("../src/lib/diagnostics");
/* eslint-enable @typescript-eslint/no-require-imports */

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
  return new Request(`http://localhost/api${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdlimit-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
let T1 = 0;

async function person(key: string, name: string, opts: { role?: "viewer" | "admin"; status?: "active" | "disabled" | "service" } = {}): Promise<Person> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
    opts.role ?? "viewer",
    opts.status ?? "active",
  ]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  let session = "";
  if ((opts.status ?? "active") === "active") {
    session = newToken();
    await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  }
  P[key] = { id, session, name };
  return P[key];
}

/** A workspace role of this file holding exactly `perms` (assigned to `userId` when given). */
async function wsRole(perms: string[], tag: string, userId?: number): Promise<number> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  const roleId = r.rows[0].id as number;
  roleIds.push(roleId);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [roleId, p]);
  if (userId) await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [roleId, userId]);
  return roleId;
}

async function deskRole(userId: number, role: string) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}

const by = () => ({ id: P.admin.id, role: "viewer" as const, name: P.admin.name });
const counted = async () => new Set(await agentsLib.deskAgentIds());

before(async () => {
  await getSetting("__schema_bootstrap__");
  await pool().query(roles.HD_ROLES_SCHEMA);
  await person("admin", "Ada Deskadmin");
  await person("agent", "Ari Agent");
  await person("newbie", "Nia Newbie");
  await person("wsadmin", "Wes Workspaceadmin", { role: "admin" });
  await person("service", "Desk API token", { status: "service" });
  await person("gone", "Gil Gone", { status: "disabled" });
  await person("reports", "Rory Reports");
  await person("derived", "Dee Derived");
  await person("fresh1", "Fay Fresh");
  await person("fresh2", "Finn Fresh");
  await person("fresh3", "Flo Fresh");
  await person("rbac", "Rob Rbac");
  await person("teamonly", "Tam Teamonly");
  for (let i = 0; i < 4; i++) await person(`race${i}`, `Race ${i}`);
  await deskRole(P.admin.id, "admin");
  await deskRole(P.agent.id, "agent");
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.service.id, "agent");
  await deskRole(P.gone.id, "agent");
  await wsRole(["helpdesk.reports"], "reports", P.reports.id);
  await wsRole(["helpdesk.agent"], "derived", P.derived.id);
  const t1 = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9101) RETURNING id", [`${STAMP} IT`]);
  T1 = t1.rows[0].id;
});

after(async () => {
  allowance = null;
  licensedOverride = undefined;
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [T1]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Who counts ---------------------------------------------------------------------------

describe("who counts against the allowance", () => {
  test("active people with a desk role count, workspace Administrators and newbies included", async () => {
    const ids = await counted();
    assert.ok(ids.has(P.admin.id), "desk Admin");
    assert.ok(ids.has(P.agent.id), "agent");
    assert.ok(ids.has(P.newbie.id), "newbie");
    assert.ok(ids.has(P.wsadmin.id), "workspace Administrator (helpdesk.admin from the role)");
    assert.ok(ids.has(P.derived.id), "workspace helpdesk.agent");
  });

  test("service accounts, deactivated people, Reports-only people and plain users don't", async () => {
    const ids = await counted();
    assert.ok(!ids.has(P.service.id), "API-token service account");
    assert.ok(!ids.has(P.gone.id), "deactivated, even with a desk role row");
    assert.ok(!ids.has(P.reports.id), "Reports-only");
    assert.ok(!ids.has(P.fresh1.id), "nobody special");
  });

  test("the count is exactly what listDeskAgents lists, and the setup checklist uses it", async () => {
    // Other files can change the desk between the reads: read until they agree.
    let agreed = false;
    for (let i = 0; i < 5 && !agreed; i++) {
      const [list, n, check] = await Promise.all([agentsLib.listDeskAgents(), agentsLib.countDeskAgents(), seed.setupChecklist()]);
      const teams = check.steps.find((s) => s.key === "teams")!;
      const m = /· (\d+) agents?$/.exec(teams.summary);
      assert.ok(m, `the summary names the agents: ${teams.summary}`);
      agreed = n === list.length && Number(m[1]) === n;
    }
    assert.ok(agreed, "countDeskAgents, listDeskAgents and the setup checklist agree");
  });

  test("a team membership alone doesn't count", async () => {
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [T1, P.teamonly.id]);
    try {
      assert.ok(!(await counted()).has(P.teamonly.id));
    } finally {
      await pool().query("DELETE FROM hd_team_members WHERE user_id = $1", [P.teamonly.id]);
    }
  });
});

// --- The block ---------------------------------------------------------------------------

describe("setDeskAgent at the limit", () => {
  test("Add agent is refused with 402 and the agent_limit body, and audited", async () => {
    allowance = 1; // this file's own agents alone are past it
    try {
      const r = await call(agentsRoute.POST, req("/helpdesk/admin/agents", P.admin.session, { user_id: P.fresh1.id, role: "agent" }));
      assert.equal(r.status, 402);
      assert.equal(r.body.code, "agent_limit");
      assert.equal(r.body.allowed, 1);
      assert.ok(Number.isInteger(r.body.used) && r.body.used >= 4, `used: ${r.body.used}`);
      assert.equal(r.body.error, "Your licence includes 1 helpdesk agent and all are in use. Buy more agents to add someone.");
      assert.deepEqual(Object.keys(r.body).sort(), ["allowed", "code", "error", "used"]);
      assert.ok(!(await counted()).has(P.fresh1.id), "not added");
      const row = (
        await pool().query("SELECT target_type, target_id, details FROM audit_log WHERE action = 'helpdesk.agent_role.refused_limit' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [
          P.admin.id,
        ])
      ).rows[0];
      assert.ok(row, "audited");
      assert.equal(row.target_type, "user");
      assert.equal(String(row.target_id), String(P.fresh1.id));
      assert.equal(row.details.role, "agent");
      assert.equal(row.details.allowed, 1);
      assert.equal(row.details.used, r.body.used);
    } finally {
      allowance = null;
    }
  });

  test("the plural message names the allowance", async () => {
    allowance = 3; // this file alone has more agents than that
    try {
      const r = await call(agentsRoute.POST, req("/helpdesk/admin/agents", P.admin.session, { user_id: P.fresh1.id, role: "newbie" }));
      assert.equal(r.status, 402);
      assert.equal(r.body.error, "Your licence includes 3 helpdesk agents and all are in use. Buy more agents to add someone.");
    } finally {
      allowance = null;
    }
  });

  test("a role for someone not yet on the desk (PATCH) is refused the same way", async () => {
    allowance = 1;
    try {
      const r = await call(agentRoute.PATCH, req(`/helpdesk/admin/agents/${P.fresh2.id}`, P.admin.session, { role: "agent" }, "PATCH"), { userId: String(P.fresh2.id) });
      assert.equal(r.status, 402);
      assert.equal(r.body.code, "agent_limit");
      assert.equal(r.body.allowed, 1);
      assert.ok(!(await counted()).has(P.fresh2.id));
      const n = await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.agent_role.refused_limit' AND actor_id = $1 AND target_id = $2", [
        P.admin.id,
        String(P.fresh2.id),
      ]);
      assert.equal(n.rows[0].n, 1);
    } finally {
      allowance = null;
    }
  });

  test("changing an existing agent's role is never refused, nor is a team change for someone off the desk", async () => {
    allowance = 1;
    try {
      const up = await call(agentRoute.PATCH, req(`/helpdesk/admin/agents/${P.newbie.id}`, P.admin.session, { role: "agent" }, "PATCH"), { userId: String(P.newbie.id) });
      assert.equal(up.status, 200, JSON.stringify(up.body));
      assert.equal(up.body.agent.role, "agent");
      const down = await call(agentRoute.PATCH, req(`/helpdesk/admin/agents/${P.newbie.id}`, P.admin.session, { role: "newbie" }, "PATCH"), { userId: String(P.newbie.id) });
      assert.equal(down.status, 200);
      // Someone counted through a workspace permission, "added" at a role: already counted.
      const derived = await call(agentsRoute.POST, req("/helpdesk/admin/agents", P.admin.session, { user_id: P.derived.id, role: "team_lead" }));
      assert.equal(derived.status, 201, JSON.stringify(derived.body));
      // Teams only, for someone not on the desk: a membership doesn't count, so nothing to refuse.
      const teams = await call(agentRoute.PATCH, req(`/helpdesk/admin/agents/${P.teamonly.id}`, P.admin.session, { team_ids: [T1] }, "PATCH"), { userId: String(P.teamonly.id) });
      assert.equal(teams.status, 200, JSON.stringify(teams.body));
      assert.ok(!(await counted()).has(P.teamonly.id));
    } finally {
      allowance = null;
      await pool().query("DELETE FROM hd_team_members WHERE user_id = $1", [P.teamonly.id]);
    }
  });

  test("unlimited (null) adds freely, and a place free adds", async () => {
    allowance = null;
    const r = await agentsLib.setDeskAgent(by(), { user_id: P.fresh3.id, role: "agent" });
    assert.equal(r.after?.role, "agent");
    await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.fresh3.id]);
    allowance = (await agentsLib.countDeskAgents()) + 50; // room, whatever the others do meanwhile
    try {
      const r2 = await agentsLib.setDeskAgent(by(), { user_id: P.fresh3.id, role: "newbie" });
      assert.equal(r2.after?.role, "newbie");
    } finally {
      allowance = null;
      await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.fresh3.id]);
    }
  });

  test("two adds at once can't both take the last place", async () => {
    const racers = [P.race0.id, P.race1.id, P.race2.id, P.race3.id];
    let proved = false;
    for (let attempt = 0; attempt < 5 && !proved; attempt++) {
      const base = await agentsLib.countDeskAgents();
      allowance = base + 1;
      const results = await Promise.allSettled(racers.map((id) => agentsLib.setDeskAgent(by(), { user_id: id, role: "agent" })));
      const won = results.filter((r) => r.status === "fulfilled").length;
      const refused = results.filter((r) => r.status === "rejected" && r.reason instanceof agentsLib.AgentLimitError);
      const ids = await counted();
      const ours = racers.filter((id) => ids.has(id)).length;
      const after = (await agentsLib.countDeskAgents()) - ours;
      allowance = null;
      await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [racers]);
      if (after !== base) continue; // another file changed the desk meanwhile: run it again
      // Another file added an agent mid-race and took it away again: every
      // refusal counted more than the base, none of them ours. Run it again.
      // (Without the lock the racers all see the base and more than one wins,
      // so this never hides a missing lock.)
      if (won === 0 && refused.length && refused.every((r) => (r as PromiseRejectedResult).reason.used > base)) continue;
      assert.equal(won, 1, "exactly one add took the last place");
      assert.equal(ours, 1);
      assert.equal(refused.length, racers.length - 1, "the others were refused for the limit");
      for (const r of refused) assert.equal((r as PromiseRejectedResult).reason.status, 402);
      proved = true;
    }
    assert.ok(proved, "the desk kept changing under the test");
  });
});

// --- Never blocked: reported -------------------------------------------------------------------

describe("other paths are never blocked, only reported", () => {
  test("an RBAC role assignment past the limit goes through, and the listing shows the desk over", async () => {
    allowance = 1;
    try {
      const roleId = await wsRole(["helpdesk.agent"], "rbac-agent");
      const r = await assignRole({ roleId, userId: P.rbac.id });
      assert.deepEqual(r, { ok: true });
      assert.ok((await counted()).has(P.rbac.id), "on the desk");
      const list = await call(agentsRoute.GET, req("/helpdesk/admin/agents", P.admin.session));
      assert.equal(list.status, 200);
      assert.equal(list.body.allowed, 1);
      assert.equal(list.body.licensed, 1);
      assert.equal(list.body.enforced, true);
      assert.equal(list.body.used, list.body.agents.length);
      assert.equal(list.body.over, list.body.used - 1);
      assert.ok(list.body.over >= 1);
      assert.equal(list.body.buy_url, "https://docs.compassdocs.io/admin/license/#helpdesk-agents");
      assert.ok(list.body.agents.some((a: { user_id: number }) => a.user_id === P.rbac.id));
      // Nobody loses desk access over it.
      assert.ok((await agentsLib.getDeskAgent(P.agent.id))?.role === "agent");
    } finally {
      allowance = null;
    }
  });

  test("unlimited: the listing says so and is never over", async () => {
    allowance = null;
    const list = await call(agentsRoute.GET, req("/helpdesk/admin/agents", P.admin.session));
    assert.equal(list.status, 200);
    assert.equal(list.body.allowed, null);
    assert.equal(list.body.licensed, null);
    assert.equal(list.body.enforced, false);
    assert.equal(list.body.over, 0);
    assert.equal(list.body.used, list.body.agents.length);
  });

  test("agentUsage: within the allowance is never over", async () => {
    allowance = 10_000;
    try {
      const u = await agentsLib.agentUsage();
      assert.equal(u.allowed, 10_000);
      assert.equal(u.over, 0);
      assert.ok(u.used >= 4);
    } finally {
      allowance = null;
    }
  });
});

// --- Grace: shown, not enforced ---------------------------------------------------------------

describe("in grace (nothing enforced, the key's number still shown)", () => {
  test("the listing reports the key's number and how far over, adds go through, diagnostics warns", async () => {
    allowance = null; // in grace nothing is enforced
    licensedOverride = 1; // the key says 1
    try {
      const list = await call(agentsRoute.GET, req("/helpdesk/admin/agents", P.admin.session));
      assert.equal(list.status, 200);
      assert.equal(list.body.allowed, null);
      assert.equal(list.body.licensed, 1);
      assert.equal(list.body.enforced, false);
      assert.equal(list.body.over, list.body.used - 1);
      assert.ok(list.body.over >= 1);
      const add = await agentsLib.setDeskAgent(by(), { user_id: P.fresh3.id, role: "agent" });
      assert.equal(add.after?.role, "agent", "not refused in grace");
      const d = await diagnostics.checkHelpdeskAgents();
      assert.equal(d?.status, "warn");
      assert.match(d!.detail, /^\d+ of 1 agent in use; not enforced while the licence is in grace, over by \d+ once renewed\.$/);
      assert.equal(d?.fix?.href, "/admin/license");
      licensedOverride = 100_000;
      const within = await diagnostics.checkHelpdeskAgents();
      assert.equal(within?.status, "warn");
      assert.match(within!.detail, /^\d+ of 100000 agents in use; not enforced while the licence is in grace\.$/);
    } finally {
      allowance = null;
      licensedOverride = undefined;
      await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.fresh3.id]);
    }
  });

  test("diagnostics when enforced: over warns with the Agents link, within passes, unlimited passes", async () => {
    try {
      allowance = 1;
      const over = await diagnostics.checkHelpdeskAgents();
      assert.equal(over?.status, "warn");
      assert.match(over!.detail, /^\d+ of 1 agent in use: over the licence by \d+\./);
      assert.equal(over?.fix?.href, "/desk/settings/agents");
      allowance = 100_000;
      const ok = await diagnostics.checkHelpdeskAgents();
      assert.equal(ok?.status, "pass");
      assert.match(ok!.detail, /^\d+ of 100000 agents in use\.$/);
      allowance = null;
      const free = await diagnostics.checkHelpdeskAgents();
      assert.equal(free?.status, "pass");
      assert.match(free!.detail, /the licence has no agent limit\.$/);
    } finally {
      allowance = null;
    }
  });
});

// --- The License page's view -----------------------------------------------------------------

describe("GET /api/admin/license", () => {
  test("adds agentsAllowed, agentsUsed, the purchase link and a Helpdesk row", async () => {
    const r = await call(licenseRoute.GET, req("/admin/license", P.wsadmin.session));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok("agentsAllowed" in r.body);
    assert.ok(r.body.agentsAllowed === null || Number.isInteger(r.body.agentsAllowed));
    assert.ok(Number.isInteger(r.body.agentsUsed), "counted: the helpdesk is on in this build");
    assert.equal(r.body.buyAgentsUrl, "https://docs.compassdocs.io/admin/license/#helpdesk-agents");
    const hd = r.body.features.find((f: { key: string }) => f.key === "helpdesk");
    assert.ok(hd, "a Helpdesk row");
    assert.equal(hd.label, "Helpdesk");
    if (r.body.license) assert.ok(r.body.license.agents === null || Number.isInteger(r.body.license.agents));
  });
});

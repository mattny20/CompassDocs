// Helpdesk 1.19.1 merge and bulk edit (agent V2): merging moves messages
// (with their times and "from #N"), attachments, CCs, followers and tags
// into the kept ticket, which keeps its number, SLA and assignee; merged
// tickets close with merged_into; workflow tickets, other teams' tickets
// and a second merge are refused; a repeat is a no-op; an emailed reply on
// a merged ticket's thread lands on the kept one; requesters are told only
// when asked. Bulk edits check each ticket and field on its own, return a
// result per ticket, and stop at 200.
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-roles does). Parallel-safe: teams,
// people and tickets are this file's own (STAMP); the role matrix is read
// through the process-local test seam, never the shared setting.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-merge-bulk.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-merge.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-merge.virtual.js");
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
    ee: () => ({ present: true, features: ["helpdesk"] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => feature === "helpdesk",
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
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const mergeShared = require("../src/lib/helpdesk/merge-shared") as typeof import("../src/lib/helpdesk/merge-shared");
const mergeRoute = require("../src/app/api/helpdesk/tickets/merge/route") as typeof import("../src/app/api/helpdesk/tickets/merge/route");
const bulkRoute = require("../src/app/api/helpdesk/tickets/bulk/route") as typeof import("../src/app/api/helpdesk/tickets/bulk/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const analytics = require("../src/lib/helpdesk/analytics/engine") as typeof import("../src/lib/helpdesk/analytics/engine");
const reportHours = require("../src/lib/helpdesk/analytics/hours") as typeof import("../src/lib/helpdesk/analytics/hours");
const reports = require("../src/lib/helpdesk/reports") as typeof import("../src/lib/helpdesk/reports");
const messagesLib = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

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

function req(url: string, session: string, body?: unknown): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdmerge-${Date.now()}-${process.pid}`;
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
const mail: { to: string; subject: string; text: string }[] = [];

async function person(key: string, name: string): Promise<Person> {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    addr,
  ]);
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

let seq = 0;
/** A ticket without the after-create hooks (no shared rules run on it). */
async function ticket(opts: { team?: number; requester?: Person; assignee?: number | null; tags?: string[]; at?: Date; source?: "portal" | "workflow"; parent?: number } = {}) {
  const who = opts.requester ?? P.req1;
  const row = await dbCore.withTx((c) =>
    tickets.insertTicketTx(c, {
      subject: `${STAMP} printer ${++seq}`,
      body: `First message ${seq}`,
      requester: { id: who.id, name: who.name, email: who.email },
      team_id: opts.team ?? T1,
      assignee_id: opts.assignee ?? null,
      tags: opts.tags ?? [],
      created_at: opts.at,
      source: opts.source,
      parent_ticket_id: opts.parent ?? null,
    })
  );
  return row;
}

const settle = () => new Promise((r) => setTimeout(r, 500));
const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const doMerge = (by: Person, body: unknown) => call(mergeRoute.POST, req("/tickets/merge", by.session, body));
const doBulk = (by: Person, body: unknown) => call(bulkRoute.POST, req("/tickets/bulk", by.session, body));

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
  for (const [k, n] of [
    ["agent", "Ana Agent"],
    ["agent2", "Abe Agent"],
    ["lead", "Lee Lead"],
    ["newbie", "Ned Newbie"],
    ["other", "Oda Otherteam"],
    ["req1", "Tom Becker"],
    ["req2", "Priya Natarajan"],
    ["req3", "Daniel Okafor"],
  ] as const) {
    await person(k, n);
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9101) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9102) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await deskRole(P.agent.id, "agent");
  await deskRole(P.agent2.id, "agent");
  await deskRole(P.lead.id, "team_lead");
  await deskRole(P.newbie.id, "newbie");
  await deskRole(P.other.id, "agent");
  for (const k of ["agent", "agent2", "newbie"]) await member(T1, P[k].id);
  await member(T1, P.lead.id, "lead");
  await member(T2, P.other.id);
  for (const k of ["req1", "req2", "req3"]) await grant(P[k].id, ["helpdesk.request"], k);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push({ to: m.to, subject: m.subject, text: m.text });
  });
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2)", [[T1, T2], userIds])).rows.map((r) => r.id);
  await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [all]);
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

function patchReq(url: string, session: string, body: unknown): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: "PATCH",
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Merge -------------------------------------------------------------------------

describe("merge", () => {
  test("moves messages (times kept, from #N), attachments, CCs, followers and tags; keeps the target's number, SLA and assignee", async () => {
    const keep = await ticket({ assignee: P.agent2.id, tags: ["vpn"], at: new Date(Date.now() - 3 * 3_600_000) });
    const a = await ticket({ requester: P.req2, tags: ["wifi", "vpn"], at: new Date(Date.now() - 2 * 3_600_000) });
    const b = await ticket({ requester: P.req3, tags: ["laptop"], at: new Date(Date.now() - 3_600_000) });
    const msgBefore = (await pool().query("SELECT id, created_at FROM hd_messages WHERE ticket_id = $1", [a.id])).rows;
    const att = await pool().query(
      "INSERT INTO hd_attachments (stored_name, filename, mime_type, size, ticket_id, message_id) VALUES ($1, 'log.txt', 'text/plain', 3, $2, $3) RETURNING id",
      [`${STAMP}-att-${a.id}`, a.id, msgBefore[0].id]
    );
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, email, name) VALUES ($1, $2, 'Outside Olga')", [b.id, `${STAMP}-olga@outside.test`]);
    await pool().query("INSERT INTO hd_ticket_followers (ticket_id, user_id) VALUES ($1, $2)", [b.id, P.lead.id]);
    const keepBefore = await row(keep.id);

    const r = await doMerge(P.agent, { keep: keep.number, merge: [a.number, b.number], notify: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.merged, [a.number, b.number]);
    assert.equal(r.body.already, false);

    const k = await row(keep.id);
    assert.equal(k.number, keepBefore.number);
    assert.equal(k.assignee_id, P.agent2.id);
    assert.equal(String(k.first_reply_due), String(keepBefore.first_reply_due), "SLA dues untouched");
    assert.equal(String(k.resolve_due), String(keepBefore.resolve_due));
    assert.equal(k.status, keepBefore.status);
    assert.deepEqual([...k.tags].sort(), ["laptop", "vpn", "wifi"]);

    const moved = (await pool().query("SELECT id, created_at, merged_from FROM hd_messages WHERE id = ANY($1)", [msgBefore.map((m) => m.id)])).rows;
    for (const m of moved) {
      assert.equal(m.merged_from, a.number, "from #a");
      assert.equal(String(m.created_at), String(msgBefore.find((x) => x.id === m.id)!.created_at), "time kept");
    }
    assert.equal((await pool().query("SELECT ticket_id FROM hd_attachments WHERE id = $1", [att.rows[0].id])).rows[0].ticket_id, keep.id);
    const ccs = (await pool().query("SELECT user_id, email FROM hd_ticket_ccs WHERE ticket_id = $1", [keep.id])).rows;
    assert.ok(ccs.some((c) => c.user_id === P.req2.id) && ccs.some((c) => c.user_id === P.req3.id), "other requesters are CCs");
    assert.ok(ccs.some((c) => c.email === `${STAMP}-olga@outside.test`), "CCs moved");
    assert.ok(!ccs.some((c) => c.user_id === P.req1.id), "never the kept ticket's own requester");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_ccs WHERE ticket_id = $1", [b.id])).rows[0].n, 0);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_followers WHERE ticket_id = $1 AND user_id = $2", [keep.id, P.lead.id])).rows[0].n, 1);

    for (const t of [a, b]) {
      const m = await row(t.id);
      assert.equal(m.status, "closed");
      assert.equal(m.merged_into, keep.id);
      const lines = (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1", [t.id])).rows;
      assert.deepEqual(lines, [{ kind: "system", body: `Merged into #${keep.number}` }]);
    }
    const info = await merge.mergeInfo(keep.id);
    assert.deepEqual(info.merged_in.map((x) => x.number), [a.number, b.number]);
    assert.equal(Object.keys(info.message_origins).length, 2);
    assert.equal((await merge.mergeInfo(a.id)).into?.number, keep.number);

    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.merged' AND target_id = $1", [String(keep.id)])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].details.merged, [a.number, b.number]);
    assert.deepEqual(audit[0].details.attachment_ids, [Number(att.rows[0].id)]);

    // The agent's detail read carries the merge for the Related card.
    const d = await call(ticketRoute.GET, req(`/tickets/${keep.number}`, P.agent.session), { number: String(keep.number) });
    assert.deepEqual(d.body.merge.merged_in.map((x: { number: number }) => x.number), [a.number, b.number]);
  });

  test("repeating a merge changes nothing; merging an already merged ticket elsewhere is refused", async () => {
    const keep = await ticket();
    const a = await ticket({ requester: P.req2 });
    const other = await ticket();
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [a.number], notify: false })).status, 200);
    const msgs = (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [keep.id])).rows[0].n;
    const again = await doMerge(P.agent, { keep: keep.number, merge: [a.number], notify: false });
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [keep.id])).rows[0].n, msgs, "no double move");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.ticket.merged' AND target_id = $1", [String(keep.id)])).rows[0].n, 1);
    const elsewhere = await doMerge(P.agent, { keep: other.number, merge: [a.number], notify: false });
    assert.equal(elsewhere.status, 409);
    assert.match(elsewhere.body.error, new RegExp(`already merged into #${keep.number}`));
    const intoMerged = await doMerge(P.agent, { keep: a.number, merge: [other.number], notify: false });
    assert.equal(intoMerged.status, 409, "a merged ticket can't be kept");
  });

  test("refuses workflow tasks and requests with a running workflow, with a reason per ticket", async () => {
    const keep = await ticket();
    const request = await ticket({ requester: P.req2 });
    const run = await pool().query("INSERT INTO hd_workflow_runs (ticket_id, state) VALUES ($1, 'running') RETURNING id", [request.id]);
    await pool().query("UPDATE hd_tickets SET workflow_run_id = $2 WHERE id = $1", [request.id, run.rows[0].id]);
    const task = await ticket({ source: "workflow", parent: request.id });
    const r = await doMerge(P.agent, { keep: keep.number, merge: [request.number, task.number], notify: false });
    assert.equal(r.status, 409);
    assert.equal(r.body.refusals.length, 2);
    assert.match(r.body.refusals.find((x: { number: number }) => x.number === request.number).reason, /workflow running/);
    assert.match(r.body.refusals.find((x: { number: number }) => x.number === task.number).reason, /task in a workflow/);
    assert.equal((await row(request.id)).merged_into, null, "nothing merged");
  });

  test("a ticket on legal hold merges only into a ticket that is also on hold", async () => {
    const keep = await ticket();
    const held = await ticket({ requester: P.req2 });
    await pool().query("UPDATE hd_tickets SET legal_hold = 1, legal_hold_at = now() WHERE id = $1", [held.id]);
    const r = await doMerge(P.agent, { keep: keep.number, merge: [held.number], notify: false });
    assert.equal(r.status, 409);
    assert.match(r.body.error, new RegExp(`#${held.number} is on legal hold\\. Take it off hold or put #${keep.number} on hold first\\.`));
    assert.equal(r.body.refusals.length, 1);
    assert.equal((await row(held.id)).merged_into, null, "nothing merged");
    assert.ok((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [held.id])).rows[0].n > 0, "messages stay");
    // A held ticket may take in one that isn't, and two held tickets merge.
    const plain = await ticket({ requester: P.req3 });
    await pool().query("UPDATE hd_tickets SET legal_hold = 1, legal_hold_at = now() WHERE id = $1", [keep.id]);
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [held.number, plain.number], notify: false })).status, 200);
    assert.equal((await row(held.id)).merged_into, keep.id);
    assert.equal((await row(keep.id)).legal_hold, 1);
  });

  test("time entries and a running timer on the merged ticket move to the kept one", async () => {
    const keep = await ticket();
    const dup = await ticket({ requester: P.req2 });
    await pool().query("INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note) VALUES ($1, $2, 45, 'printer')", [dup.id, P.agent.id]);
    await pool().query(
      "INSERT INTO hd_timers (user_id, ticket_id, started_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET ticket_id = EXCLUDED.ticket_id, started_at = EXCLUDED.started_at",
      [P.agent2.id, dup.id]
    );
    try {
      const r = await doMerge(P.agent, { keep: keep.number, merge: [dup.number], notify: false });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.moved.time_entries, 1);
      assert.equal(r.body.moved.timers, 1);
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_time_entries WHERE ticket_id = $1 AND minutes = 45", [keep.id])).rows[0].n, 1);
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_time_entries WHERE ticket_id = $1", [dup.id])).rows[0].n, 0);
      assert.equal((await pool().query("SELECT ticket_id FROM hd_timers WHERE user_id = $1", [P.agent2.id])).rows[0].ticket_id, keep.id);
    } finally {
      await pool().query("DELETE FROM hd_timers WHERE user_id = $1", [P.agent2.id]);
    }
  });

  test("a reply or status change racing a merge is refused under the merge's lock", async () => {
    const keep = await ticket();
    const dup = await ticket({ requester: P.req2 });
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [dup.number], notify: false })).status, 200);
    // The route's mergedLock ran before the merge committed; the core re-checks on the locked row.
    for (const kind of ["public", "internal"] as const) {
      await assert.rejects(
        messagesLib.addMessage(dup.id, { kind, body: "Raced", author: { id: P.agent.id, name: P.agent.name, email: P.agent.email }, via: "desk", asRequester: false }),
        (e: unknown) => e instanceof tickets.HdTicketError && e.status === 409 && new RegExp(`merged into #${keep.number}`).test(e.message)
      );
    }
    await assert.rejects(
      messagesLib.addMessage(dup.id, { kind: "public", body: "Raced", author: { id: P.req2.id, name: P.req2.name, email: P.req2.email }, via: "portal", asRequester: true }),
      (e: unknown) => e instanceof tickets.HdTicketError && e.status === 409
    );
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE body = 'Raced'")).rows[0].n, 0);
    await assert.rejects(tickets.updateTicket(dup.id, { status: "open" }, { id: P.agent.id, name: P.agent.name }), (e: unknown) => e instanceof tickets.HdTicketError && e.status === 409);
    assert.equal((await row(dup.id)).status, "closed");
    const pri = await tickets.updateTicket(dup.id, { priority: "low" }, { id: P.agent.id, name: P.agent.name });
    assert.deepEqual(pri?.changed, ["priority"], "other fields still change");
  });

  test("a ticket on legal hold can't be deleted by hand", async () => {
    const admin = P.deskadmin ?? (await person("deskadmin", "Dee Deskadmin"));
    await deskRole(admin.id, "admin");
    await member(T1, admin.id);
    const held = await ticket();
    await pool().query("UPDATE hd_tickets SET legal_hold = 1, legal_hold_at = now() WHERE id = $1", [held.id]);
    const del = (n: number) =>
      call(ticketRoute.DELETE, new Request(`http://localhost/api/helpdesk/tickets/${n}`, { method: "DELETE", headers: { cookie: `compass_session=${admin.session}` } }), {
        number: String(n),
      });
    const r = await del(held.number);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /legal hold/);
    assert.ok(await row(held.id), "still there");
    assert.equal(await tickets.deleteTicket(held.id), undefined, "the core refuses too");
    assert.ok(await row(held.id));
    const plain = await ticket();
    assert.equal((await del(plain.number)).status, 200);
    // 1.19.4 (C7): Delete moves it to the recycle bin (test/helpdesk-recycle-bin); the purge removes it later.
    assert.ok((await row(plain.id)).deleted_at, "in the recycle bin");
  });

  test("refuses other teams' tickets (as not found) and roles without tickets.merge", async () => {
    const keep = await ticket();
    const foreign = await ticket({ team: T2, requester: P.req2 });
    const r = await doMerge(P.agent, { keep: keep.number, merge: [foreign.number], notify: false });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /wasn't found in your queues/);
    const newbie = await doMerge(P.newbie, { keep: keep.number, merge: [foreign.number], notify: false });
    assert.equal(newbie.status, 403, "Newbie holds no tickets.merge");
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [keep.number] })).status, 400);
  });

  test("notify: on tells the merged ticket's requester (public note + email); off tells nobody", async () => {
    const keep = await ticket();
    const a = await ticket({ requester: P.req2 });
    mail.length = 0;
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [a.number], notify: true })).status, 200);
    await settle();
    const notes = (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [a.id])).rows;
    assert.ok(notes.some((n) => n.kind === "system" && n.body === mergeShared.mergedNote(keep.number)), JSON.stringify(notes));
    const sent = mail.filter((m) => m.to === P.req2.email);
    assert.equal(sent.length, 1, JSON.stringify(mail));
    assert.match(sent[0].subject, new RegExp(`#${a.number} was joined with #${keep.number}`));
    assert.ok(!mail.some((m) => m.to === P.req1.email), "the kept ticket's requester is not mailed");

    const keep2 = await ticket();
    const b = await ticket({ requester: P.req3 });
    mail.length = 0;
    assert.equal((await doMerge(P.agent, { keep: keep2.number, merge: [b.number], notify: false })).status, 200);
    await settle();
    assert.equal(mail.length, 0);
    assert.ok(!(await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1", [b.id])).rows.some((n) => n.body.includes("joined with")));
  });

  test("an emailed reply on a merged ticket's thread lands on the kept ticket", async () => {
    const keep = await ticket();
    const a = await ticket({ requester: P.req2 });
    const token = await email.ensureReplyToken(a.id);
    assert.ok(token);
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [a.number], notify: false })).status, 200);
    const res = await inbound.processInboundEmail(
      {
        provider: "generic",
        from: { email: P.req2.email, name: P.req2.name },
        to: [{ email: "help@example.test", name: "" }],
        cc: [],
        recipients: [],
        subject: `Re: ${STAMP} printer [#${a.number} ref:${token}]`,
        text: "Still broken after the restart.",
        html: "",
        stripped: "",
        messageId: `${newToken()}@mail.example.test`,
        inReplyTo: "",
        references: [],
        headers: {},
        auth: { dmarc: "pass" },
        files: [],
      } as never,
      { outsideSenders: false }
    );
    assert.equal(res.body.outcome, "appended", JSON.stringify(res.body));
    assert.equal(res.body.ticket, keep.number);
    const last = (await pool().query("SELECT ticket_id, author_id FROM hd_messages WHERE body LIKE '%Still broken after the restart%'")).rows;
    assert.deepEqual(last, [{ ticket_id: keep.id, author_id: P.req2.id }]);
    assert.equal((await row(a.id)).status, "closed", "the merged ticket stays closed");
  });

  test("an emailed reply racing a merge (committed after the thread lookup) is retried once onto the kept ticket", async () => {
    const mailOn = (t: { number: number }, token: string, from: Person, text: string) =>
      ({
        provider: "generic",
        from: { email: from.email, name: from.name },
        to: [{ email: "help@example.test", name: "" }],
        cc: [],
        recipients: [],
        subject: `Re: ${STAMP} printer [#${t.number} ref:${token}]`,
        text,
        html: "",
        stripped: "",
        messageId: `${newToken()}@mail.example.test`,
        inReplyTo: "",
        references: [],
        headers: {},
        auth: { dmarc: "pass" },
        files: [],
      }) as never;
    const keep = await ticket();
    const a = await ticket({ requester: P.req2 });
    const token = (await email.ensureReplyToken(a.id))!;
    const seen: number[] = [];
    // The seam runs between the thread lookup and addMessage: the merge commits there, once.
    inbound.setInboundBeforeAppendForTests(async (ticketId) => {
      seen.push(ticketId);
      if (seen.length === 1) assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [a.number], notify: false })).status, 200);
    });
    try {
      const res = await inbound.processInboundEmail(mailOn(a, token, P.req2, "Raced the merge, still broken."), { outsideSenders: false });
      assert.equal(res.body.outcome, "appended", JSON.stringify(res.body));
      assert.equal(res.body.ticket, keep.number);
      assert.deepEqual(seen, [a.id, keep.id], "looked up again and retried onto the kept ticket");
      const msgs = (await pool().query("SELECT ticket_id, author_id FROM hd_messages WHERE body LIKE '%Raced the merge, still broken%'")).rows;
      assert.deepEqual(msgs, [{ ticket_id: keep.id, author_id: P.req2.id }], "one message, on the kept ticket, as its requester");
      assert.equal((await row(a.id)).merged_into, keep.id);
    } finally {
      inbound.setInboundBeforeAppendForTests(null);
    }

    // Retried once only: when the retry races a merge again, it fails as before (a 409, nothing written).
    const keep2 = await ticket();
    const keep3 = await ticket();
    const b = await ticket({ requester: P.req3 });
    const token2 = (await email.ensureReplyToken(b.id))!;
    const seen2: number[] = [];
    inbound.setInboundBeforeAppendForTests(async (ticketId) => {
      seen2.push(ticketId);
      if (seen2.length === 1) assert.equal((await doMerge(P.agent, { keep: keep2.number, merge: [b.number], notify: false })).status, 200);
      if (seen2.length === 2) assert.equal((await doMerge(P.agent, { keep: keep3.number, merge: [keep2.number], notify: false })).status, 200);
    });
    try {
      await assert.rejects(
        inbound.processInboundEmail(mailOn(b, token2, P.req3, "Raced twice."), { outsideSenders: false }),
        (e: unknown) => e instanceof tickets.HdTicketError && e.status === 409
      );
      assert.deepEqual(seen2, [b.id, keep2.id], "one retry, no more");
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE body LIKE '%Raced twice%'")).rows[0].n, 0);
    } finally {
      inbound.setInboundBeforeAppendForTests(null);
    }
  });
});

// --- Bulk ----------------------------------------------------------------------------

// 1.19.1 integration: a merged ticket closed into another; it was never solved, and it is read-only.
describe("merged tickets in reports and on the desk", () => {
  test("a merged ticket counts as created, never as solved, in the analytics engine, the report summary and its drill-down", async () => {
    // A team of this test's own, so the counts are exactly these tickets.
    const T3 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9103) RETURNING id", [`${STAMP} Reports`])).rows[0].id as number;
    try {
      await member(T3, P.agent.id);
      const solved = await ticket({ team: T3 });
      const keep = await ticket({ team: T3 });
      const dup = await ticket({ team: T3, requester: P.req2 });
      // Only the duplicate carries a resolution target: a default reply-target policy would
      // otherwise give the others a business-hours due date that falls inside or outside the
      // report range depending on the day of the week the test runs.
      await pool().query("UPDATE hd_tickets SET resolve_due = NULL, first_reply_due = NULL WHERE id = ANY($1::int[])", [[solved.id, keep.id]]);
      const p = await call(ticketRoute.PATCH, patchReq(`/tickets/${solved.number}`, P.agent.session, { status: "solved" }), { number: String(solved.number) });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      // A resolution target on the duplicate: the merge must neither meet nor miss it.
      await pool().query("UPDATE hd_tickets SET resolve_due = now() + interval '1 hour' WHERE id = $1", [dup.id]);
      assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [dup.number], notify: false })).status, 200);
      const merged = await row(dup.id);
      assert.ok(merged.solved_at, "the merge stamps solved_at (the queue's closed clock)");

      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      const range = { from: day(-1), to: day(1) };
      const HOURS = { timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", holidays: [] };
      reportHours.setReportHoursForTests(HOURS);
      try {
        const scope = { kind: "all" as const, userId: P.lead.id };
        const run = (measure: string) =>
          analytics.runQuery({ measure, range, filters: { team: [T3] } } as never, { id: P.lead.id, role: "viewer" }, { scope: scope as never, tz: "UTC" });
        assert.equal((await run("created")).total.value, 3, "the duplicate was created");
        assert.equal((await run("solved")).total.value, 1, "only the ticket really solved");
        assert.equal((await run("resolution_median")).total.n, 1, "resolution times leave the merged ticket out");
        assert.equal((await run("sla_resolution_pct")).total.n, 0, "the merge decided no resolution target");
      } finally {
        reportHours.setReportHoursForTests(null);
      }

      const summary = await reports.reportSummary({ ...range, team_id: T3 }, { hours: HOURS as never });
      assert.equal(summary.created, 3);
      assert.equal(summary.solved, 1);
      assert.equal(summary.sla_met_percent, null, "no decided target");

      const drill = await tickets.listTickets({ id: P.agent.id, role: "viewer" }, { view: "all", team_id: T3, solved_from: range.from, solved_to: range.to });
      assert.deepEqual(drill.rows.map((r) => r.number), [solved.number], "the drill-down lists what the report counted");
      const week = await tickets.listTickets({ id: P.agent.id, role: "viewer" }, { view: "solved_week", team_id: T3 });
      assert.deepEqual(week.rows.map((r) => r.number), [solved.number], "Solved this week leaves the merged ticket out");
    } finally {
      const ids = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1", [T3])).rows.map((r) => r.id);
      await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [ids]);
      await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ids]);
      await pool().query("DELETE FROM hd_teams WHERE id = $1", [T3]);
    }
  });

  test("a merged ticket is read-only: replies, notes and status changes answer 409 naming the kept ticket; other fields still change", async () => {
    const keep = await ticket();
    const dup = await ticket({ requester: P.req2 });
    assert.equal((await doMerge(P.agent, { keep: keep.number, merge: [dup.number], notify: false })).status, 200);
    const ctx = { number: String(dup.number) };
    for (const kind of ["public", "internal"]) {
      const r = await call(messagesRoute.POST, req(`/tickets/${dup.number}/messages`, P.agent.session, { kind, body: "Still broken?" }), ctx);
      assert.equal(r.status, 409, kind);
      assert.match(r.body.error, new RegExp(`merged into #${keep.number}`));
    }
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND body = 'Still broken?'", [dup.id])).rows[0].n, 0);
    const reopen = await call(ticketRoute.PATCH, patchReq(`/tickets/${dup.number}`, P.agent.session, { status: "open" }), ctx);
    assert.equal(reopen.status, 409);
    assert.match(reopen.body.error, new RegExp(`#${keep.number}`));
    assert.equal((await row(dup.id)).status, "closed");
    const same = await call(ticketRoute.PATCH, patchReq(`/tickets/${dup.number}`, P.agent.session, { status: "closed", priority: "low" }), ctx);
    assert.equal(same.status, 200, "an unchanged status is no change");
    assert.equal((await row(dup.id)).priority, "low");
    // The kept ticket is not locked.
    const onKeep = await call(messagesRoute.POST, req(`/tickets/${keep.number}/messages`, P.agent.session, { kind: "internal", body: "Merged, carry on here" }), {
      number: String(keep.number),
    });
    assert.equal(onKeep.status, 201, JSON.stringify(onKeep.body));
  });
});

describe("bulk edit", () => {
  test("applies per ticket with partial success: other teams' tickets and merged ones are skipped with a reason", async () => {
    const t1 = await ticket();
    const t2 = await ticket({ tags: ["old", "keep"] });
    const foreign = await ticket({ team: T2 });
    const merged = await ticket();
    await pool().query("UPDATE hd_tickets SET merged_into = $2, status = 'closed' WHERE id = $1", [merged.id, t1.id]);
    const r = await doBulk(P.agent, {
      numbers: [t1.number, t2.number, foreign.number, merged.number],
      patch: { priority: "high", status: "pending", add_tags: ["bulk"], remove_tags: ["old"] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, 2);
    assert.equal(r.body.skipped, 2);
    const by = (n: number) => r.body.results.find((x: { number: number }) => x.number === n);
    assert.equal(by(t1.number).ok, true);
    assert.deepEqual([...by(t1.number).changed].sort(), ["priority", "status", "tags"]);
    assert.match(by(foreign.number).error, /Not found in your queues/);
    assert.match(by(merged.number).error, /Merged into another ticket/);
    const r2 = await row(t2.id);
    assert.equal(r2.priority, "high");
    assert.equal(r2.status, "pending");
    assert.deepEqual([...r2.tags].sort(), ["bulk", "keep"]);
    assert.ok(r2.sla_paused_at, "the same SLA pause as PATCH");
    const line = (await pool().query("SELECT kind FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%changed the priority%'", [t2.id])).rows;
    assert.equal(line.length, 1, "timeline line per ticket");
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.bulk_updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.agent.id])).rows[0];
    assert.equal(audit.details.requested, 4);
    assert.equal(audit.details.updated, 2);
    assert.equal(audit.details.skipped, 2);
  });

  test("each field needs its own capability: an Agent can't assign to a teammate; a role without priority keeps it", async () => {
    const t = await ticket();
    const r = await doBulk(P.agent, { numbers: [t.number], patch: { assignee_id: P.agent2.id } });
    assert.equal(r.body.results[0].ok, false);
    assert.match(r.body.results[0].error, /can't assign/);
    const self = await doBulk(P.agent, { numbers: [t.number], patch: { assignee_id: P.agent.id } });
    assert.equal(self.body.results[0].ok, true, "taking it is assign_self");
    const lead = await doBulk(P.lead, { numbers: [t.number], patch: { assignee_id: P.agent2.id } });
    assert.equal(lead.body.results[0].ok, true, "a lead assigns within the team");

    roles.setRoleMatrixForTests({ ...shared.HD_DEFAULT_MATRIX, agent: shared.HD_DEFAULT_MATRIX.agent.filter((c) => c !== "tickets.change_priority") });
    try {
      const p = await doBulk(P.agent, { numbers: [t.number], patch: { priority: "urgent" } });
      assert.match(p.body.results[0].error, /can't change the priority/);
      assert.equal((await row(t.id)).priority, "normal");
      roles.setRoleMatrixForTests({ ...shared.HD_DEFAULT_MATRIX, agent: shared.HD_DEFAULT_MATRIX.agent.filter((c) => c !== "tickets.bulk") });
      assert.equal((await doBulk(P.agent, { numbers: [t.number], patch: { priority: "low" } })).status, 403);
    } finally {
      roles.setRoleMatrixForTests(shared.HD_DEFAULT_MATRIX);
    }
    assert.equal((await doBulk(P.newbie, { numbers: [t.number], patch: { priority: "low" } })).status, 403, "Newbie holds no tickets.bulk");
  });

  test("a workflow task asks for its hand-off, as PATCH does", async () => {
    const parent = await ticket();
    const task = await ticket({ source: "workflow", parent: parent.id });
    const definition = {
      trigger: {},
      steps: [{ kind: "task", key: "t1", title: "Set up the laptop", team_id: T1, outputs: [{ key: "asset", label: "Asset tag", type: "text", required: true }] }],
    };
    const run = await pool().query("INSERT INTO hd_workflow_runs (ticket_id, state, current) VALUES ($1, 'running', $2) RETURNING id", [
      parent.id,
      JSON.stringify({ definition, index: 0 }),
    ]);
    await pool().query("INSERT INTO hd_workflow_steps (run_id, step_key, kind, state, task_ticket_id) VALUES ($1, 't1', 'task', 'active', $2)", [
      run.rows[0].id,
      task.id,
    ]);
    const r = await doBulk(P.agent, { numbers: [task.number], patch: { status: "solved" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].ok, false);
    assert.match(r.body.results[0].error, /Record the hand-off before solving: Asset tag/);
    assert.notEqual((await row(task.id)).status, "solved");
  });

  test("at most 200 tickets; an empty or unknown patch is refused", async () => {
    const many = Array.from({ length: 201 }, (_, i) => 900000 + i);
    const r = await doBulk(P.agent, { numbers: many, patch: { priority: "low" } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Up to 200 tickets/);
    assert.equal((await doBulk(P.agent, { numbers: [1], patch: {} })).status, 400);
    assert.equal((await doBulk(P.agent, { numbers: [1], patch: { subject: "x" } })).status, 400);
    assert.equal((await doBulk(P.agent, { numbers: [1], patch: { status: "bogus" } })).status, 400);
  });
});

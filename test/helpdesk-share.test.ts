// Helpdesk 1.19.4 (area C6): share a ticket with an agent, print a ticket.
// Against the database:
//   - the share dialog lists every other desk agent; those who can't work
//     the ticket are listed disabled with the reason, never the caller;
//   - a share reaches only agents who work the ticket (sharing never grants
//     access: one outsider refuses the whole share and nothing is written);
//   - a share writes one internal timeline line (never shown to the
//     requester), makes the recipients follow (respecting an earlier
//     unfollow), audits helpdesk.ticket.shared, and sends the desk event
//     shared_with_me (bell + email hd_shared);
//   - the printed ticket: the conversation always, internal notes only when
//     asked, never a held or returned newbie reply; details, checklists,
//     time and attachment names on request;
//   - the print audit is the server's (recordPrintView: the parts it rendered,
//     one row per agent, ticket and parts a minute); no route takes a list
//     from the browser;
//   - review fixes (1.19.4): a reply to the hd_shared email is an internal
//     note, never a public reply; only the structured marker
//     (hd_messages.event) makes a share line; a binned ticket answers 409 to
//     an agent who could work it (404 to anyone else) and a share racing the
//     bin writes nothing; the dialog's batched access check agrees with
//     canWorkTicket for every desk agent on the rig;
//   - the pure rules (print options, share line, message limit) and the
//     notification catalog entry with its email.
//
// Fixtures are this file's own (two stamped teams, their accounts, tickets);
// no workspace setting is written.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-share.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- Request scope and licence stubs (as test/helpdesk-ccs.test.ts) ------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-share.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-share.virtual.js");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk" };
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
const share = require("../src/lib/helpdesk/share") as typeof import("../src/lib/helpdesk/share");
const shared = require("../src/lib/helpdesk/share-shared") as typeof import("../src/lib/helpdesk/share-shared");
const ccs = require("../src/lib/helpdesk/ccs") as typeof import("../src/lib/helpdesk/ccs");
const access = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const policy = require("../src/lib/notify-policy-shared") as typeof import("../src/lib/notify-policy-shared");
const prefsShared = require("../src/lib/helpdesk/notify-prefs-shared") as typeof import("../src/lib/helpdesk/notify-prefs-shared");
const templates = require("../src/lib/email-templates") as typeof import("../src/lib/email-templates");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const shareRoute = require("../src/app/api/helpdesk/tickets/[number]/share/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/share/route");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const settingsLib = require("../src/lib/helpdesk/settings") as typeof import("../src/lib/helpdesk/settings");
const rolesAgents = require("../src/lib/helpdesk/roles-agents") as typeof import("../src/lib/helpdesk/roles-agents");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdshare-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = "Share!Test12345";
type Person = { id: number; email: string; session: string; name: string };
const U: Record<"req" | "agent" | "agent2" | "agent3" | "outsider" | "allq", Person> = {} as never;
const ALIAS = `${STAMP}-it@example.test`;
let teamId = 0;
let otherTeamId = 0;
const ticketIds: number[] = [];
const mail: HelpdeskOutgoingMail[] = [];

const settle = () => new Promise((r) => setTimeout(r, 400));

function req(url: string, who: Person | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.91",
    "user-agent": "ShareTest/1.0",
    origin: "http://localhost",
    host: "localhost",
  };
  if (who) headers.cookie = `compass_session=${who.session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call<P>(handler: (r: Request, ctx: { params: Promise<P> }) => Promise<Response>, r: Request, params: P) {
  currentRequest = r;
  try {
    const res = await handler(r, { params: Promise.resolve(params) });
    const type = res.headers.get("content-type") ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (type.includes("json") ? await res.json() : await res.text()) as any };
  } finally {
    currentRequest = null;
  }
}

async function newTicket(subject: string) {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} ${subject}`,
      body: "Since this morning the VPN client says Authentication failed.",
      requester: { id: U.req.id, name: U.req.name, email: U.req.email },
      team_id: teamId,
      via: "portal",
      source: "portal",
    } as never,
    { silent: true }
  );
  ticketIds.push(t.id);
  return t;
}

const shareUrl = (n: number) => `http://localhost/api/helpdesk/tickets/${n}/share`;

before(async () => {
  await getSetting("__schema_bootstrap__");
  const creds = hashPassword(PASSWORD);
  const names = { req: "Daniel Okafor", agent: "Ana Kowalski", agent2: "Sam Lee", agent3: "Marco Rossi", outsider: "Lena Fischer", allq: "Priya Natarajan" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const addr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, `${name} ${STAMP.slice(-6)}`, addr, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: addr, session, name: `${name} ${STAMP.slice(-6)}` };
  }
  for (const k of ["agent", "agent2", "agent3", "outsider"] as const) {
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'`,
      [U[k].id]
    );
  }
  // An explicit desk role (Agent) in no team, with the workspace's agent_all key: the floor gives every queue.
  await fixtureQuery(
    `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-manager'`,
    [U.allq.id]
  );
  await fixtureQuery("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent')", [U.allq.id]);
  teamId = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 995) RETURNING id", [`${STAMP} IT`, ALIAS])).rows[0].id;
  otherTeamId = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 996) RETURNING id", [`${STAMP} Facilities`])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $6, 'agent')", [
    teamId,
    U.agent.id,
    U.agent2.id,
    U.agent3.id,
    otherTeamId,
    U.outsider.id,
  ]);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  const ids = Object.values(U).map((u) => u.id);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR id = ANY($3)", [[teamId, otherTeamId], ids, ticketIds])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamId, otherTeamId]]);
  await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM user_notify_prefs WHERE user_id = ANY($1)", [ids]).catch(() => undefined);
  await pool().query("DELETE FROM notify_digest_queue WHERE user_id = ANY($1)", [ids]).catch(() => undefined);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await pool().end();
});

// --- Pure rules ---------------------------------------------------------------------

describe("share-shared", () => {
  test("print options: defaults and the query", () => {
    assert.deepEqual(shared.parsePrintInclude(undefined), { details: true, notes: false, checklists: true, time: false, attachments: true });
    assert.deepEqual(shared.parsePrintInclude("notes,time,bogus"), { details: false, notes: true, checklists: false, time: true, attachments: false });
    assert.deepEqual(shared.parsePrintInclude(""), { details: false, notes: false, checklists: false, time: false, attachments: false });
    assert.equal(shared.printHref(1047, shared.HD_PRINT_DEFAULTS), "/desk/tickets/1047/print?include=details%2Cchecklists%2Cattachments&print=1");
    assert.equal(shared.printFooter("Ana", "6 Nov 2026, 14:05", false), "Printed by Ana on 6 Nov 2026, 14:05. Internal notes not included.");
  });

  test("share line, names, message limit", () => {
    assert.equal(shared.nameList(["A", "B", "C"]), "A, B and C");
    const line = shared.shareLine("Ana", ["Sam", "Marco"]);
    assert.equal(line, "Ana shared this with Sam and Marco");
    // The marker decides, never the text.
    assert.equal(shared.isShareLine({ kind: "internal", event: "share" }), true);
    assert.equal(shared.isShareLine({ kind: "internal", event: null }), false, "text alone never makes a share line");
    assert.equal(shared.isShareLine({ kind: "public", event: "share" }), false);
    assert.equal(shared.cleanShareMessage("  hi\r\nthere\u0007 "), "hi\nthere");
    assert.equal(shared.cleanShareMessage("x".repeat(501)), null);
    assert.equal(shared.cleanShareMessage(undefined), "");
    assert.equal(shared.cleanShareMessage(5), null);
  });

  test("the notification catalog, the email and the audit labels", async () => {
    assert.ok(prefsShared.HD_NOTIFY_EVENTS.includes("shared_with_me"));
    const ev = policy.NOTIFY_EVENTS.find((e) => e.id === "desk_shared_with_me");
    assert.ok(ev, "catalog entry");
    assert.deepEqual(ev!.templates, ["hd_shared"]);
    assert.deepEqual(ev!.channels, { bell: true, push: true, email: true });
    const out = await templates.renderEmail(
      "hd_shared",
      { ...templates.SAMPLE_VARS.hd_shared, message: "[click](https://evil.example) **now**", org_name: "Acme" },
      "https://desk.example.test"
    );
    assert.match(out.subject, /shared #1047 with you/);
    assert.ok(!out.html.includes('href="https://evil.example"'), "the message is text, never a link");
    assert.ok(out.html.includes("/desk/tickets/1047"));
    assert.equal(auditLabels.actionLabel("helpdesk.ticket.shared"), "Shared a ticket with an agent");
    assert.equal(auditLabels.actionLabel("helpdesk.ticket.printed"), "Printed a ticket");
  });
});

// --- Share ----------------------------------------------------------------------------

describe("share a ticket", () => {
  test("the dialog lists every other agent; outsiders disabled with the reason", async () => {
    const t = await newTicket("Candidates");
    const r = await call(shareRoute.GET, req(shareUrl(t.number), U.agent, undefined, "GET"), { number: String(t.number) });
    assert.equal(r.status, 200);
    const mine = r.body.candidates.filter((c: { user_id: number }) => Object.values(U).some((u) => u.id === c.user_id));
    const by = new Map(mine.map((c: { user_id: number }) => [c.user_id, c]));
    assert.ok(!by.has(U.agent.id), "never the caller");
    assert.ok(!by.has(U.req.id), "the requester is not on the desk");
    assert.deepEqual(
      { can: (by.get(U.agent2.id) as { can_see: boolean }).can_see, reason: (by.get(U.agent2.id) as { reason: string | null }).reason },
      { can: true, reason: null }
    );
    const out = by.get(U.outsider.id) as { can_see: boolean; reason: string; teams: string };
    assert.equal(out.can_see, false);
    assert.equal(out.reason, `Can't see ${STAMP} IT tickets`);
    assert.equal(out.teams, `${STAMP} Facilities`);
    // Those who can receive it come first; the ticket's own team before other agents; the disabled last.
    const order = r.body.candidates.map((c: { user_id: number }) => c.user_id);
    const firstDisabled = r.body.candidates.findIndex((c: { can_see: boolean }) => !c.can_see);
    assert.ok(r.body.candidates.slice(firstDisabled).every((c: { can_see: boolean }) => !c.can_see));
    assert.ok(order.indexOf(U.agent2.id) < 2 && order.indexOf(U.agent3.id) < 2, "the ticket's team first");
    // The outsider can't even list it.
    const no = await call(shareRoute.GET, req(shareUrl(t.number), U.outsider, undefined, "GET"), { number: String(t.number) });
    assert.equal(no.status, 404);
    const requester = await call(shareRoute.GET, req(shareUrl(t.number), U.req, undefined, "GET"), { number: String(t.number) });
    assert.equal(requester.status, 403, "not an agent");
  });

  test("sharing writes an agents-only line, follows, audits and notifies", async () => {
    const t = await newTicket("Shared VPN");
    mail.length = 0;
    const r = await call(
      shareRoute.POST,
      req(shareUrl(t.number), U.agent, { user_ids: [U.agent2.id, U.agent3.id], message: "Can you check the MFA side?", follow: true }),
      { number: String(t.number) }
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.shared.map((s: { user_id: number }) => s.user_id), [U.agent2.id, U.agent3.id]);
    assert.deepEqual([...r.body.followed].sort(), [U.agent2.id, U.agent3.id].sort());

    const line = (await pool().query("SELECT kind, via, author_id, body, event FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%shared this with%'", [t.id])).rows;
    assert.equal(line.length, 1);
    assert.deepEqual(line[0], { kind: "internal", via: "system", author_id: U.agent.id, body: `${U.agent.name} shared this with ${U.agent2.name} and ${U.agent3.name}`, event: "share" });

    const followers = (await ccs.listFollowers(t.id)).map((f) => f.userId);
    assert.ok(followers.includes(U.agent2.id) && followers.includes(U.agent3.id));

    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.shared' AND target_id = $1", [String(t.id)])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].details.recipients, [U.agent2.id, U.agent3.id]);
    assert.equal(audit[0].details.message_chars, "Can you check the MFA side?".length);
    assert.ok(!JSON.stringify(audit[0].details).includes("MFA"), "the message text stays out of the audit log");

    await settle();
    const bells = (await pool().query("SELECT user_id, title, body, link FROM notifications WHERE user_id = ANY($1) AND link = $2", [[U.agent2.id, U.agent3.id], `/desk/tickets/${t.number}`])).rows;
    assert.equal(bells.length, 2);
    assert.equal(bells[0].title, `${U.agent.name} shared #${t.number} with you`);
    assert.match(bells[0].body, /Can you check the MFA side\?/);
    assert.match(bells[0].body, /You now follow it/);
    const toAgent2 = mail.filter((m) => m.to === U.agent2.email);
    assert.equal(toAgent2.length, 1, "one email to the recipient");
    assert.match(toAgent2[0].subject, new RegExp(`shared #${t.number} with you`));
    assert.match(toAgent2[0].text, /Can you check the MFA side/);
    assert.equal(mail.filter((m) => m.to === U.req.email).length, 0, "nothing to the requester");

    // The requester's view never shows the line.
    const asRequester = await call(requestRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}`, U.req, undefined, "GET"), { number: String(t.number) });
    assert.equal(asRequester.status, 200);
    assert.ok(!JSON.stringify(asRequester.body).includes("shared this with"));
    const safe = access.requesterMessages(await messages.listMessages(t.id));
    assert.ok(safe.every((m) => !m.body.includes("shared this with")));
  });

  test("never grants access: one outsider refuses the whole share and nothing is written", async () => {
    const t = await newTicket("Not for Facilities");
    const r = await call(shareRoute.POST, req(shareUrl(t.number), U.agent, { user_ids: [U.agent2.id, U.outsider.id] }), { number: String(t.number) });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /can't see/);
    const lines = await pool().query("SELECT 1 FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%shared this with%'", [t.id]);
    assert.equal(lines.rowCount, 0);
    assert.equal((await ccs.listFollowers(t.id)).length, 0);
    assert.equal(await access.canWorkTicket({ id: U.outsider.id, role: "viewer" }, t), false);
    const audit = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.ticket.shared' AND target_id = $1", [String(t.id)]);
    assert.equal(audit.rowCount, 0);
  });

  test("an earlier unfollow is respected; bad bodies are refused", async () => {
    const t = await newTicket("Unfollowed");
    await ccs.unfollowTicket(t.id, U.agent2.id, { userId: U.agent2.id, name: U.agent2.name, via: "desk" });
    const r = await call(shareRoute.POST, req(shareUrl(t.number), U.agent, { user_ids: [U.agent2.id] }), { number: String(t.number) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.followed, []);
    assert.equal(await ccs.isFollowing(t.id, U.agent2.id), false);

    const bad = async (body: unknown) => (await call(shareRoute.POST, req(shareUrl(t.number), U.agent, body), { number: String(t.number) })).status;
    assert.equal(await bad({ user_ids: [] }), 400);
    assert.equal(await bad({ user_ids: [U.agent.id] }), 400, "not with yourself");
    assert.equal(await bad({ user_ids: ["x"] }), 400);
    assert.equal(await bad({ user_ids: [U.agent2.id], message: "x".repeat(501) }), 400);
    assert.equal(await bad({ user_ids: [U.req.id] }), 404, "not on the desk");
    assert.equal(await bad({ user_ids: Array.from({ length: 11 }, (_, i) => i + 1) }), 400);
  });

  test("follow off: nobody new follows", async () => {
    const t = await newTicket("No follow");
    const r = await call(shareRoute.POST, req(shareUrl(t.number), U.agent, { user_ids: [U.agent3.id], follow: false }), { number: String(t.number) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.followed, []);
    assert.equal(await ccs.isFollowing(t.id, U.agent3.id), false);
  });
});

// --- Print ------------------------------------------------------------------------------

describe("print a ticket", () => {
  test("notes only when asked; held and returned replies never", async () => {
    const t = await newTicket("Print me");
    const by = { id: U.agent.id, name: U.agent.name, email: U.agent.email };
    await messages.addMessage(t.id, { kind: "public", body: "Try re-pairing the client.", author: by, via: "desk" }, { silent: true });
    await messages.addMessage(t.id, { kind: "internal", body: "MFA token cached, secret note", author: by, via: "desk" }, { silent: true });
    await pool().query(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, review_state) VALUES ($1, $2, $3, 'public', 'held for review text', 'desk', 'pending'), ($1, $2, $3, 'public', 'returned reply text', 'desk', 'returned')",
      [t.id, U.agent2.id, U.agent2.name]
    );
    await pool().query(
      `UPDATE hd_messages SET attachments = '[{"id":1,"name":"vpn-error.png","size":86016,"type":"image/png"}]'::jsonb WHERE ticket_id = $1 AND body = 'Try re-pairing the client.'`,
      [t.id]
    );
    await pool().query("INSERT INTO hd_time_entries (ticket_id, user_id, minutes, note) VALUES ($1, $2, 25, 'investigation')", [t.id, U.agent.id]);
    await share.shareTicket({ id: U.agent.id, role: "viewer", name: U.agent.name }, t, { user_ids: [U.agent2.id], message: "", follow: false });

    const user = { id: U.agent.id, role: "viewer" as const, name: U.agent.name };
    const plain = await share.ticketPrintView(user, t, shared.HD_PRINT_DEFAULTS);
    const text = JSON.stringify(plain);
    assert.ok(text.includes("Try re-pairing"));
    assert.ok(text.includes("Since this morning"), "the opening message");
    assert.ok(!text.includes("secret note"), "no internal note by default");
    assert.ok(!text.includes("held for review"), "never a held reply");
    assert.ok(!text.includes("returned reply"), "never a returned reply");
    assert.deepEqual(plain.attachments, ["vpn-error.png (84 KB)"]);
    assert.equal(plain.time, null);
    assert.ok(plain.details?.some(([k, v]) => k === "Team" && v === `${STAMP} IT`));
    assert.ok(plain.details?.some(([k, v]) => k === "Requester" && v.includes(U.req.email)));
    assert.match(plain.footer, /Internal notes not included\.$/);
    assert.equal(plain.team, `${STAMP} IT`);

    const withNotes = await share.ticketPrintView(user, t, { ...shared.HD_PRINT_DEFAULTS, notes: true, time: true, details: false });
    const t2 = JSON.stringify(withNotes);
    assert.ok(t2.includes("secret note"));
    assert.ok(!t2.includes("held for review") && !t2.includes("returned reply"));
    assert.equal(withNotes.details, null);
    assert.equal(withNotes.time?.total, "25m");
    assert.equal(withNotes.messages.find((m) => m.internal && !m.system)?.meta.includes("internal note"), true);
    assert.ok(withNotes.messages.some((m) => m.system && m.body.includes("shared this with")), "a share prints as an event line");
    assert.ok(!plain.messages.some((m) => m.body.includes("shared this with")), "and never without notes");
    assert.match(withNotes.footer, /Internal notes included\.$/);
  });

  test("the print audit is the server's: the parts rendered, once a minute, nothing from the browser", async () => {
    const t = await newTicket("Audit print");
    const actor = { id: U.agent.id, role: "viewer" as const, name: U.agent.name };
    const withNotes = { ...shared.HD_PRINT_DEFAULTS, notes: true };
    assert.equal(await share.recordPrintView(actor, t, withNotes, "203.0.113.91"), true);
    assert.equal(await share.recordPrintView(actor, t, withNotes, "203.0.113.91"), false, "a reload within the minute is the same print");
    assert.equal(await share.recordPrintView(actor, t, shared.HD_PRINT_DEFAULTS), true, "other parts are another print");
    const rows = (await pool().query("SELECT actor_id, details, ip FROM audit_log WHERE action = 'helpdesk.ticket.printed' AND target_id = $1 ORDER BY id", [String(t.id)])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor_id, U.agent.id);
    assert.deepEqual(rows[0].details, { number: t.number, details: true, notes: true, checklists: true, time: false, attachments: true });
    assert.equal(rows[0].ip, "203.0.113.91");
    assert.equal(rows[1].details.notes, false);
    // No route takes a list of printed parts from the browser any more.
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(path.join(__dirname, "..", "src", "app", "api", "helpdesk", "tickets", "[number]", "printed")), false);
    const page = (await import("node:fs")).readFileSync(path.join(__dirname, "..", "src", "app", "(print)", "desk", "tickets", "[number]", "print", "page.tsx"), "utf8");
    assert.match(page, /recordPrintView\(\{[^)]*\}, ticket, options, ip\)/, "the page records the options it parsed and rendered");
  });
});

// --- Review fixes ---------------------------------------------------------------------

function inboundEmail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: U.req.email, name: "" },
    to: [{ email: ALIAS, name: "" }],
    cc: [],
    recipients: [],
    subject: `${STAMP} Re`,
    text: "",
    html: "",
    stripped: "",
    messageId: `${newToken()}@mail.example.test`,
    inReplyTo: "",
    references: [],
    headers: {},
    auth: { dmarc: "pass" },
    files: [],
    ...over,
  } as InboundEmail;
}

describe("review fixes", () => {
  test("HIGH: the hd_shared email is agent-only; a reply to it is an internal note, never a public reply", async () => {
    // Inbound configured, as on a live desk (so an ordinary ticket mail would carry a Reply-To);
    // the same lock and restore as test/helpdesk-review-fixes-s2.
    const LOCK = 728351;
    const lock = await pool().connect();
    await lock.query("SELECT pg_advisory_lock($1)", [LOCK]);
    const before = await settingsLib.getHelpdeskSettings();
    try {
      await settingsLib.saveHelpdeskSettings({
        inbound_secret: before.inbound_secret || settingsLib.newInboundSecret(),
        inbound_address: before.inbound_address || "help@example.test",
      });
      const t = await newTicket("Reply to a share");
      mail.length = 0;
      // Marco shares (Ana's 10-a-minute share limit is spent by the tests above).
      const r = await call(shareRoute.POST, req(shareUrl(t.number), U.agent3, { user_ids: [U.agent2.id], message: "Don't promise Daniel a date yet." }), { number: String(t.number) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await settle();
      const m = mail.find((x) => x.to === U.agent2.email);
      assert.ok(m, "the hd_shared mail went out");
      assert.equal(m!.replyTo, undefined, "no Reply-To on the inbound address");
      assert.ok(!m!.subject.includes("ref:"), m!.subject);
      assert.ok(email.isNoteNoticeMessageId(m!.messageId!), m!.messageId);
      assert.match(m!.text, /Don't reply to this email/);
      assert.ok(email.HD_AGENT_ONLY_TEMPLATES.has("hd_shared"));
      // Control: an ordinary agent mail on the same ticket still threads (the S3 rule stands).
      await email.sendHelpdeskEmail(U.agent2.id, "hd_assigned", { ticket_number: String(t.number) });
      assert.ok(mail.find((x) => x.to === U.agent2.email && x !== m)?.replyTo?.includes("+hd-"));

      // Sam answers the email: it lands as his internal note, and the requester hears nothing.
      mail.length = 0;
      const id = m!.messageId!.replace(/^<|>$/g, "");
      const res = await inbound.processInboundEmail(
        inboundEmail({ from: { email: U.agent2.email, name: "" }, subject: `Re: ${m!.subject}`, inReplyTo: id, references: [m!.references!.replace(/^<|>$/g, ""), id], text: "On it, his manager says not to escalate." }),
        { outsideSenders: false, trustUnverified: false }
      );
      assert.equal(res.body.outcome, "appended", JSON.stringify(res.body));
      const last = (await pool().query("SELECT kind, author_id, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
      assert.equal(last.kind, "internal");
      assert.equal(last.author_id, U.agent2.id);
      assert.match(last.body, /not to escalate/);
      await settle();
      assert.equal(mail.filter((x) => x.to === U.req.email).length, 0, "nothing reaches the requester");
    } finally {
      await settingsLib.saveHelpdeskSettings({ inbound_secret: before.inbound_secret, inbound_address: before.inbound_address });
      await lock.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
      lock.release();
    }
  });

  test("only the marker makes a share line: a note that reads like one stays a note", async () => {
    const t = await newTicket("Lookalike");
    // As the checklist timeline writes an item title the agent typed.
    await pool().query(
      `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, $3, 'internal', $4, 'system')`,
      [t.id, U.agent.id, U.agent.name, `${U.agent.name} ticked "VPN" shared this with the CISO`]
    );
    await share.shareTicket({ id: U.agent.id, role: "viewer", name: U.agent.name }, t, { user_ids: [U.agent2.id], message: "", follow: false });
    const listed = await messages.listMessages(t.id);
    const fake = listed.find((m) => m.body.includes("the CISO"))!;
    const real = listed.find((m) => m.body === `${U.agent.name} shared this with ${U.agent2.name}`)!;
    assert.equal(fake.event ?? null, null);
    assert.equal(shared.isShareLine(fake), false, "the lookalike is drawn as what it is");
    assert.equal(real.event, "share");
    assert.equal(shared.isShareLine(real), true);
    // The marker is agent-side: a requester's messages never carry the key.
    assert.ok(access.requesterMessages(listed).every((m) => !("event" in m)));
  });

  test("a binned ticket: 409 to an agent who could work it, 404 to anyone else; a share racing the bin writes nothing", async () => {
    const t = await newTicket("Binned");
    try {
      await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [t.id]);
      const post = await call(shareRoute.POST, req(shareUrl(t.number), U.agent, { user_ids: [U.agent2.id] }), { number: String(t.number) });
      assert.equal(post.status, 409);
      assert.equal(post.body.error, shared.HD_SHARE_BINNED);
      assert.equal((await call(shareRoute.GET, req(shareUrl(t.number), U.agent, undefined, "GET"), { number: String(t.number) })).status, 409);
      assert.equal((await call(shareRoute.POST, req(shareUrl(t.number), U.outsider, { user_ids: [U.agent2.id] }), { number: String(t.number) })).status, 404, "no existence leak");
      assert.equal((await call(shareRoute.GET, req(shareUrl(999_999_999), U.agent, undefined, "GET"), { number: "999999999" })).status, 404);

      // The race: loaded live, binned before the writes. The row lock refuses; nothing lands.
      await assert.rejects(
        share.shareTicket({ id: U.agent.id, role: "viewer", name: U.agent.name }, t, { user_ids: [U.agent2.id], message: "", follow: true }),
        (e: unknown) => e instanceof share.HdShareError && e.status === 409
      );
      assert.equal((await pool().query("SELECT 1 FROM hd_messages WHERE ticket_id = $1 AND event = 'share'", [t.id])).rowCount, 0);
      assert.equal((await pool().query("SELECT 1 FROM hd_ticket_followers WHERE ticket_id = $1", [t.id])).rowCount, 0);
      assert.equal((await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.ticket.shared' AND target_id = $1", [String(t.id)])).rowCount, 0);
    } finally {
      await pool().query("UPDATE hd_tickets SET deleted_at = NULL WHERE id = $1", [t.id]);
    }
  });

  test("the dialog's batched access check agrees with canWorkTicket for every desk agent", async () => {
    const t = await newTicket("Batch");
    const assigned = { ...t, assignee_id: U.outsider.id };
    const agents = await rolesAgents.listDeskAgents();
    const roles = new Map((await pool().query("SELECT id, role FROM users WHERE id = ANY($1)", [agents.map((a) => a.user_id)])).rows.map((r) => [r.id, r.role]));
    for (const ticket of [t, assigned]) {
      const batch = await share.canWorkMany(agents, ticket);
      const mismatches: string[] = [];
      for (const a of agents) {
        const one = await access.canWorkTicket({ id: a.user_id, role: roles.get(a.user_id) }, ticket);
        if (one !== batch.get(a.user_id)) mismatches.push(`${a.username} (${a.role}): batch ${batch.get(a.user_id)}, one ${one}`);
      }
      assert.deepEqual(mismatches, [], `${agents.length} agents checked`);
    }
    const batch = await share.canWorkMany(agents, t);
    assert.equal(batch.get(U.allq.id), true, "explicit Agent + the agent_all floor: every queue");
    assert.equal(batch.get(U.outsider.id), false);
    assert.equal((await share.canWorkMany(agents, assigned)).get(U.outsider.id), true, "assigned to them");
    // The candidate list costs a fixed number of queries, whatever the desk's size.
    const r = await call(shareRoute.GET, req(shareUrl(t.number), U.agent, undefined, "GET"), { number: String(t.number) });
    assert.equal(r.status, 200);
    const allq = r.body.candidates.find((c: { user_id: number }) => c.user_id === U.allq.id);
    assert.equal(allq.can_see, true);
  });
});

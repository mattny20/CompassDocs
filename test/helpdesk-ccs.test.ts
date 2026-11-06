// Helpdesk 1.19.1, CCs and followers (agent V3), against the database:
//   - a CC reads the request as the requester does (public conversation
//     only, never internal notes or held replies), may reply in public, and
//     never reaches the desk's agent view;
//   - outside addresses are copied only while outside senders are allowed;
//     an address that belongs to an account copies the account;
//   - inbound email: a new ticket's Cc become CCs (verified senders only,
//     never the helpdesk's own addresses); a CC's reply on the thread joins
//     the ticket; an unverified one never does;
//   - an agent's public reply mails the requester with the CCs on Cc, and
//     the CCs' bells follow the notification policy;
//   - followers hear of replies, notes and status changes through the
//     desk preferences (off is off), only while they may work the ticket;
//     an agent who replies follows, unless they turned that off or
//     unfollowed the ticket;
//   - merge helpers move CCs and followers inside the caller's transaction.
//
// Fixtures are this file's own (a team with a unique alias, its accounts,
// its tickets); workspace settings are never written: inbound takes
// outsideSenders as an argument and addCcs an explicit outsideAllowed.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-ccs.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- Request scope and licence stubs (as test/helpdesk-channels.test.ts) -------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-ccs.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-ccs.virtual.js");
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
const ccs = require("../src/lib/helpdesk/ccs") as typeof import("../src/lib/helpdesk/ccs");
const access = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notifyMod = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const prefsMod = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const dbCore = require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const requestMsgRoute = require("../src/app/api/helpdesk/requests/[number]/messages/route") as typeof import("../src/app/api/helpdesk/requests/[number]/messages/route");
const requestCcsRoute = require("../src/app/api/helpdesk/requests/[number]/ccs/route") as typeof import("../src/app/api/helpdesk/requests/[number]/ccs/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const ticketCcsRoute = require("../src/app/api/helpdesk/tickets/[number]/ccs/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/ccs/route");
const followRoute = require("../src/app/api/helpdesk/tickets/[number]/follow/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/follow/route");
const review = require("../src/lib/helpdesk/review") as typeof import("../src/lib/helpdesk/review");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdcc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALIAS = `${STAMP}-it@example.test`;
const PASSWORD = "Ccs!Test12345";
type Person = { id: number; email: string; session: string; name: string };
const U: Record<"req" | "agent" | "agent2" | "colleague" | "stranger" | "outsider_agent", Person> = {} as never;
let teamId = 0;
let otherTeamId = 0;
const ticketIds: number[] = [];
const mail: HelpdeskOutgoingMail[] = [];
const followerHits: { userId: number; title: string }[] = [];
const OUTSIDE = `${STAMP}-vendor@outside.example.test`;

const settle = () => new Promise((r) => setTimeout(r, 300));

function req(url: string, who: Person | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.90",
    "user-agent": "CcsTest/1.0",
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
      body: "Opening message",
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

function inboundEmail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: U.req.email, name: "" },
    to: [{ email: ALIAS, name: "" }],
    cc: [],
    recipients: [],
    subject: `${STAMP} Printer jammed`,
    text: "The third-floor printer is jammed.",
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

before(async () => {
  await getSetting("__schema_bootstrap__");
  const creds = hashPassword(PASSWORD);
  const names = { req: "Daniel Okafor", agent: "Ana Kowalski", agent2: "Sam Lee", colleague: "Priya Natarajan", stranger: "Tom Becker", outsider_agent: "Grace Lin" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const addr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, name, addr, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: addr, session, name };
  }
  for (const k of ["agent", "agent2", "outsider_agent"] as const) {
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'`,
      [U[k].id]
    );
  }
  teamId = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 997) RETURNING id", [`${STAMP} IT`, ALIAS])).rows[0].id;
  otherTeamId = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 998) RETURNING id", [`${STAMP} Facilities`])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($4, $5, 'agent')", [
    teamId,
    U.agent.id,
    U.agent2.id,
    otherTeamId,
    U.outsider_agent.id,
  ]);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
  ccs.setFollowerSpyForTests((userId, title) => followerHits.push({ userId, title }));
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  ccs.setFollowerSpyForTests(null);
  const ids = Object.values(U).map((u) => u.id);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR id = ANY($3)", [[teamId, otherTeamId], ids, ticketIds])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamId, otherTeamId]]);
  await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM user_notify_prefs WHERE user_id = ANY($1)", [ids]).catch(() => undefined);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await pool().end();
});

// --- Access: a CC reads as the requester does ---------------------------------------

describe("CC access is public-only", () => {
  test("a CC sees the request with public messages only, may reply, and never the desk view", async () => {
    const t = await newTicket("VPN from home");
    await messages.addMessage(t.id, { kind: "internal", body: "MFA token cached, secret note", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" }, { silent: true });
    await messages.addMessage(t.id, { kind: "public", body: "Try re-pairing the client.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" }, { silent: true });

    // Not copied yet: a colleague cannot open it.
    assert.equal(await access.ticketRelation({ id: U.colleague.id, role: "viewer" }, t), null);
    assert.equal((await call(requestRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}`, U.colleague, undefined, "GET"), { number: String(t.number) })).status, 404);

    const res = await ccs.addCcs(t.id, [{ userId: U.colleague.id }], { userId: U.req.id, name: U.req.name, via: "portal" });
    assert.equal(res.added.length, 1);
    assert.equal(await access.ticketRelation({ id: U.colleague.id, role: "viewer" }, t), "cc");

    const got = await call(requestRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}`, U.colleague, undefined, "GET"), { number: String(t.number) });
    assert.equal(got.status, 200);
    const bodies = got.body.request.messages.map((m: { body: string; kind: string }) => m.body).join("\n");
    assert.ok(!bodies.includes("secret note"), "no internal note");
    assert.ok(got.body.request.messages.every((m: { kind: string }) => m.kind !== "internal"));
    assert.ok(bodies.includes("Try re-pairing"), "the public reply");
    assert.equal(got.body.request.can_reply, true);

    // The desk's agent view stays closed to a CC.
    const desk = await call(ticketRoute.GET, req(`http://localhost/api/helpdesk/tickets/${t.number}`, U.colleague, undefined, "GET"), { number: String(t.number) });
    assert.ok(desk.status === 403 || desk.status === 404, `desk view refused (${desk.status})`);

    // A CC replies in public, as the requester does.
    const posted = await call(requestMsgRoute.POST, req(`http://localhost/api/helpdesk/requests/${t.number}/messages`, U.colleague, { body: "Same issue here." }), { number: String(t.number) });
    assert.equal(posted.status, 201);
    const last = (await pool().query("SELECT kind, author_id FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual(last, { kind: "public", author_id: U.colleague.id });

    // A CC can see the list but cannot add people; the requester can.
    const asCc = await call(requestCcsRoute.POST, req(`http://localhost/api/helpdesk/requests/${t.number}/ccs`, U.colleague, { people: [{ user_id: U.stranger.id }] }), { number: String(t.number) });
    assert.equal(asCc.status, 404);
    const list = await call(requestCcsRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}/ccs`, U.colleague, undefined, "GET"), { number: String(t.number) });
    assert.equal(list.status, 200);
    assert.equal(list.body.viewer_is_cc, true);
    assert.equal(list.body.can_add, false);
    assert.equal(list.body.ccs[0].email, "", "an account's address is not shown to requesters");
    const stranger = await call(requestCcsRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}/ccs`, U.stranger, undefined, "GET"), { number: String(t.number) });
    assert.equal(stranger.status, 404);
  });

  test("a CC never reads a held reply (newbie review)", async () => {
    const t = await newTicket("Held reply");
    await ccs.addCcs(t.id, [{ userId: U.colleague.id }], { userId: U.req.id, via: "portal" });
    await pool().query(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, review_state) VALUES ($1, $2, $3, 'public', 'held for review text', 'desk', 'pending')",
      [t.id, U.agent.id, U.agent.name]
    );
    const got = await call(requestRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}`, U.colleague, undefined, "GET"), { number: String(t.number) });
    assert.equal(got.status, 200);
    assert.ok(!JSON.stringify(got.body).includes("held for review text"));
  });

  test("an agent copied on a ticket they work replies from the desk, never through the requester's route", async () => {
    const t = await newTicket("Agent as CC");
    const self = await call(ticketCcsRoute.POST, req(`http://localhost/api/helpdesk/tickets/${t.number}/ccs`, U.agent, { people: [{ user_id: U.agent.id }] }), { number: String(t.number) });
    assert.equal(self.status, 200);
    assert.equal(await ccs.isCcOf(U.agent.id, t.id), true);
    const countMsgs = async () => (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public'", [t.id])).rows[0].n;
    const before = await countMsgs();
    const posted = await call(requestMsgRoute.POST, req(`http://localhost/api/helpdesk/requests/${t.number}/messages`, U.agent, { body: "Unreviewed reply" }), { number: String(t.number) });
    assert.equal(posted.status, 409);
    assert.equal(posted.body.desk_url, `/desk/tickets/${t.number}`);
    assert.equal(await countMsgs(), before, "nothing was posted");
    const got = await call(requestRoute.GET, req(`http://localhost/api/helpdesk/requests/${t.number}`, U.agent, undefined, "GET"), { number: String(t.number) });
    assert.equal(got.status, 200);
    assert.equal(got.body.request.can_reply, false, "no Get help reply box for someone who works it");
    // An agent of another team, copied by the requester, is a plain CC there and may reply.
    await ccs.addCcs(t.id, [{ userId: U.outsider_agent.id }], { userId: U.req.id, via: "portal" });
    const cc = await call(requestMsgRoute.POST, req(`http://localhost/api/helpdesk/requests/${t.number}/messages`, U.outsider_agent, { body: "Same here." }), { number: String(t.number) });
    assert.equal(cc.status, 201);
  });
});

// --- Outside CCs ------------------------------------------------------------------

describe("outside CCs follow the outside-senders setting", () => {
  test("refused while outside senders are off, added while on; an account's address copies the account", async () => {
    const t = await newTicket("Outside CC");
    const off = await ccs.addCcs(t.id, [{ email: OUTSIDE }], { userId: U.agent.id, via: "desk", outsideAllowed: false });
    assert.equal(off.added.length, 0);
    assert.equal(off.skipped[0].reason, "outside_not_allowed");
    const on = await ccs.addCcs(t.id, [{ email: OUTSIDE.toUpperCase() }], { userId: U.agent.id, via: "desk", outsideAllowed: true });
    assert.equal(on.added.length, 1);
    assert.equal(on.added[0].userId, null);
    assert.equal(on.added[0].email, OUTSIDE);
    const again = await ccs.addCcs(t.id, [{ email: OUTSIDE }], { userId: U.agent.id, via: "desk", outsideAllowed: true });
    assert.equal(again.skipped[0].reason, "already", "case-insensitive de-duplication");
    const acct = await ccs.addCcs(t.id, [{ email: U.stranger.email.toUpperCase() }], { userId: U.agent.id, via: "desk", outsideAllowed: false });
    assert.equal(acct.added[0].userId, U.stranger.id, "a directory account by address");
    const self = await ccs.addCcs(t.id, [{ userId: U.req.id }, { email: "not an address" }], { userId: U.agent.id, via: "desk" });
    assert.deepEqual(self.skipped.map((s) => s.reason), ["requester", "invalid_email"]);
    // The audit and the requester-visible timeline line.
    const audits = (await pool().query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1", [String(t.id)])).rows.map((r) => r.action);
    assert.ok(audits.includes("helpdesk.ticket.cc_added"));
    const line = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'system' ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.match(line.body, /as CC\.$/);
  });

  test("without an explicit answer the workspace setting decides", async () => {
    const t = await newTicket("Outside CC setting");
    const { getHelpdeskSettings } = await import("../src/lib/helpdesk/settings");
    const allowed = (await getHelpdeskSettings()).outside_senders;
    const r = await ccs.addCcs(t.id, [{ email: `x-${OUTSIDE}` }], { userId: U.agent.id, via: "desk" });
    assert.equal(r.added.length, allowed ? 1 : 0);
  });

  test("an agent copies through the desk route; a requester's own route refuses others", async () => {
    const t = await newTicket("Desk route");
    const r = await call(ticketCcsRoute.POST, req(`http://localhost/api/helpdesk/tickets/${t.number}/ccs`, U.agent, { people: [{ user_id: U.colleague.id }] }), { number: String(t.number) });
    assert.equal(r.status, 200);
    assert.equal(r.body.people.ccs[0].user_id, U.colleague.id);
    assert.equal(r.body.people.ccs[0].email, U.colleague.email, "agents see addresses");
    const other = await call(ticketCcsRoute.POST, req(`http://localhost/api/helpdesk/tickets/${t.number}/ccs`, U.outsider_agent, { people: [{ user_id: U.stranger.id }] }), { number: String(t.number) });
    assert.equal(other.status, 404, "an agent of another team cannot");
    const bell = (await pool().query("SELECT title FROM notifications WHERE user_id = $1 AND link = $2", [U.colleague.id, `/help/requests/${t.number}`])).rows;
    assert.ok(bell.some((b) => /added you as CC/.test(b.title)), "the copied person is told");
  });
});

// --- Inbound email ------------------------------------------------------------------

describe("inbound CC handling", () => {
  test("a new ticket's Cc become CCs: accounts, outside only when allowed, never the helpdesk's addresses", async () => {
    const r1 = await inbound.processInboundEmail(
      inboundEmail({
        cc: [
          { email: U.colleague.email, name: "" },
          { email: OUTSIDE, name: "Vendor" },
          { email: ALIAS, name: "" },
          { email: U.req.email, name: "" },
        ],
      }),
      { outsideSenders: false }
    );
    assert.equal(r1.body.outcome, "created");
    const t1 = await tickets.getTicketByNumber(r1.body.ticket!);
    ticketIds.push(t1!.id);
    const c1 = await ccs.listCcs(t1!.id);
    assert.deepEqual(c1.map((c) => c.userId), [U.colleague.id], "the colleague only");

    const r2 = await inbound.processInboundEmail(inboundEmail({ cc: [{ email: U.colleague.email, name: "" }, { email: OUTSIDE, name: "Vendor" }] }), { outsideSenders: true });
    const t2 = await tickets.getTicketByNumber(r2.body.ticket!);
    ticketIds.push(t2!.id);
    const c2 = await ccs.listCcs(t2!.id);
    assert.equal(c2.length, 2);
    assert.ok(c2.some((c) => c.userId === null && c.email === OUTSIDE));
  });

  test("an unverified sender's Cc are not copied", async () => {
    const r = await inbound.processInboundEmail(inboundEmail({ auth: {} as never, cc: [{ email: U.colleague.email, name: "" }] }), {
      outsideSenders: true,
      trustUnverified: false,
    });
    assert.equal(r.body.outcome, "created", "an outsider ticket while outside senders are on");
    const t = await tickets.getTicketByNumber(r.body.ticket!);
    ticketIds.push(t!.id);
    assert.equal((await ccs.listCcs(t!.id)).length, 0);
  });

  test("a CC's verified reply joins the ticket; an unverified one never does; a stranger's opens their own", async () => {
    const t = await newTicket("Thread reply");
    await ccs.addCcs(t.id, [{ userId: U.colleague.id }, { email: OUTSIDE }], { userId: U.req.id, via: "portal", outsideAllowed: true });
    const token = await email.ensureReplyToken(t.id);
    const subject = `Re: ${STAMP} Thread reply [#${t.number} ref:${token}]`;
    const before = Number((await pool().query("SELECT count(*) FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].count);

    const ok = await inbound.processInboundEmail(inboundEmail({ from: { email: U.colleague.email, name: "" }, subject, text: "Me too, since Monday." }), { outsideSenders: false });
    assert.equal(ok.body.outcome, "appended");
    assert.equal(ok.body.ticket, t.number);

    const outsideOk = await inbound.processInboundEmail(inboundEmail({ from: { email: OUTSIDE, name: "" }, subject, text: "Vendor here." }), { outsideSenders: true });
    assert.equal(outsideOk.body.outcome, "appended", "an outside CC while outside senders are on");

    const forged = await inbound.processInboundEmail(inboundEmail({ from: { email: U.colleague.email, name: "" }, subject, text: "forged", auth: { dmarc: "fail" } as never }), {
      outsideSenders: false,
    });
    assert.notEqual(forged.body.outcome, "appended", "an unverified CC never writes into the ticket");

    const stranger = await inbound.processInboundEmail(inboundEmail({ from: { email: U.stranger.email, name: "" }, subject, text: "Hi" }), { outsideSenders: false });
    assert.equal(stranger.body.outcome, "created");
    assert.notEqual(stranger.body.ticket, t.number);
    ticketIds.push((await tickets.getTicketByNumber(stranger.body.ticket!))!.id);

    const msgs = (await pool().query("SELECT author_id, author_email, body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id", [t.id])).rows;
    assert.equal(msgs.length - (before - 0) <= 2, true);
    assert.ok(msgs.some((m) => m.author_id === U.colleague.id && m.body === "Me too, since Monday."));
    assert.ok(msgs.some((m) => m.author_email === OUTSIDE && m.body === "Vendor here."));
    assert.ok(!msgs.some((m) => m.body === "forged"));
  });
});

// --- Outgoing mail ----------------------------------------------------------------

describe("outgoing public replies carry the CCs", () => {
  // Outside CCs are mailed only while outside senders are on (this process's answer; the workspace setting is untouched).
  before(() => ccs.setOutsideSendersForTests(true));
  after(() => ccs.setOutsideSendersForTests(null));

  test("an agent's public reply: To the requester, Cc the CCs; a note mails no CC", async () => {
    const t = await newTicket("Cc header");
    await ccs.addCcs(t.id, [{ userId: U.colleague.id }, { email: OUTSIDE }], { userId: U.req.id, via: "portal", outsideAllowed: true });
    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "I've reset your VPN token.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" });
    await settle();
    const toReq = mail.find((m) => m.to === U.req.email && m.text.includes("reset your VPN token"));
    assert.ok(toReq, JSON.stringify(mail.map((m) => [m.to, m.cc, m.subject])));
    const cc = (toReq!.cc ?? "").split(",").map((s) => s.trim());
    assert.ok(cc.includes(OUTSIDE), `outside CC on Cc: ${toReq!.cc}`);
    assert.ok(cc.includes(U.colleague.email.toLowerCase()), `account CC on Cc (instant email by default): ${toReq!.cc}`);
    assert.ok(!cc.includes(U.req.email), "never the requester twice");
    assert.equal(mail.filter((m) => m.text.includes("reset your VPN token")).length, 1, "one mail, the CCs on it");

    // The requester opts out of that email: the CCs still get one mail of their own.
    const { saveUserNotifyPrefs, emptyPrefs } = await import("../src/lib/notify-policy");
    await saveUserNotifyPrefs(U.req.id, { ...emptyPrefs(), channels: { hd_desk_replied: { email: false } } });
    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Second reply.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" });
    await settle();
    const second = mail.filter((m) => m.text.includes("Second reply."));
    assert.ok(second.length >= 1, "someone is mailed");
    assert.ok(second.some((m) => [m.to, ...(m.cc ?? "").split(",").map((s) => s.trim())].includes(OUTSIDE)), JSON.stringify(second.map((m) => [m.to, m.cc])));
    const bell = (await pool().query("SELECT title FROM notifications WHERE user_id = $1 AND link = $2 ORDER BY id DESC", [U.colleague.id, `/help/requests/${t.number}`])).rows;
    assert.ok(bell.some((b) => /replied on/.test(b.title)), "the CC's bell (requester event)");

    mail.length = 0;
    await messages.addMessage(t.id, { kind: "internal", body: "secret internal", author: { id: U.agent2.id, name: U.agent2.name, email: U.agent2.email }, via: "desk" });
    await settle();
    assert.ok(!mail.some((m) => (m.cc ?? "").includes(OUTSIDE) || m.to === OUTSIDE), "internal notes never reach CCs");
  });

  test("the transport receives cc only for real addresses, never for an internal-note notice", async () => {
    mail.length = 0;
    const t = await newTicket("Note notice");
    const sent = await email.sendHelpdeskTemplate(U.agent.email, "hd_internal_note", { ticket_number: String(t.number), subject: "x", author_name: "y", message: "z", ticket_url: "/desk" }, { ticketId: t.id, number: t.number }, "", {
      cc: [OUTSIDE],
    });
    assert.equal(sent, true);
    assert.equal(mail.at(-1)!.cc, undefined);
    await email.sendHelpdeskTemplate(U.req.email, "hd_reply", { ticket_number: String(t.number), subject: "x", author_name: "y", message: "z", ticket_url: "/help" }, { ticketId: t.id, number: t.number }, "", {
      cc: [OUTSIDE, "bad address, evil@x.test", U.req.email],
    });
    assert.equal(mail.at(-1)!.cc, OUTSIDE);
  });
});

// --- Followers --------------------------------------------------------------------

describe("followers", () => {
  test("followers hear of notes, replies and status changes; prefs off is off; access is rechecked", async () => {
    const t = await newTicket("Followed");
    assert.equal(await ccs.followTicket(t.id, U.agent2.id, { userId: U.agent2.id, via: "desk" }), true);
    followerHits.length = 0;
    await messages.addMessage(t.id, { kind: "internal", body: "Checked the logs.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" });
    await settle();
    assert.ok(followerHits.some((h) => h.userId === U.agent2.id && /added a note/.test(h.title)), JSON.stringify(followerHits));
    const bell = async () =>
      Number((await pool().query("SELECT count(*) FROM notifications WHERE user_id = $1 AND link = $2", [U.agent2.id, `/desk/tickets/${t.number}`])).rows[0].count);
    const first = await bell();
    assert.ok(first >= 1, "the bell (default on)");

    await tickets.updateTicket(t.id, { status: "pending" }, { id: U.agent.id, name: U.agent.name });
    await settle();
    assert.ok(followerHits.some((h) => h.userId === U.agent2.id && /is now/.test(h.title)), "a status change");

    // The follower switches the event's bell off: nothing new lands in the bell.
    await prefsMod.saveNotifyPrefs(U.agent2.id, { matrix: { followed_update: { bell: false, push: false, email: false } } });
    const before = await bell();
    await messages.addMessage(t.id, { kind: "internal", body: "Another note.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" });
    await settle();
    assert.equal(await bell(), before, "off is off");

    // An author never hears of their own message; an agent who no longer works the ticket hears nothing.
    await ccs.followTicket(t.id, U.outsider_agent.id, { userId: U.outsider_agent.id, via: "desk" });
    followerHits.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Public update.", author: { id: U.agent2.id, name: U.agent2.name, email: U.agent2.email }, via: "desk" });
    await settle();
    assert.ok(!followerHits.some((h) => h.userId === U.agent2.id), "not the author");
    assert.ok(!followerHits.some((h) => h.userId === U.outsider_agent.id), "not someone outside the team");
  });

  test("an agent who replies follows; not with auto-follow off; never after unfollowing", async () => {
    const t = await newTicket("Auto follow");
    const author = { id: U.agent.id, name: U.agent.name, email: U.agent.email };
    await messages.addMessage(t.id, { kind: "public", body: "On it.", author, via: "desk" }, { silent: true });
    await settle();
    assert.equal(await ccs.isFollowing(t.id, U.agent.id), true, "replying follows");
    assert.equal(await ccs.unfollowTicket(t.id, U.agent.id, { userId: U.agent.id, via: "desk" }), true);
    await messages.addMessage(t.id, { kind: "internal", body: "note", author, via: "desk" }, { silent: true });
    await settle();
    assert.equal(await ccs.isFollowing(t.id, U.agent.id), false, "an unfollow sticks");
    assert.equal(await ccs.followTicket(t.id, U.agent.id, { userId: U.agent.id, via: "desk" }), true, "Follow overrides it");

    const t2 = await newTicket("Auto follow off");
    await prefsMod.saveNotifyPrefs(U.agent.id, { auto_follow: false });
    await messages.addMessage(t2.id, { kind: "public", body: "Reply.", author, via: "desk" }, { silent: true });
    await settle();
    assert.equal(await ccs.isFollowing(t2.id, U.agent.id), false, "auto-follow off");
    await prefsMod.saveNotifyPrefs(U.agent.id, { auto_follow: true });

    // The requester never follows by writing.
    await messages.addMessage(t2.id, { kind: "public", body: "Thanks", author: { id: U.req.id, name: U.req.name, email: U.req.email }, via: "portal", asRequester: true }, { silent: true });
    await settle();
    assert.equal(await ccs.isFollowing(t2.id, U.req.id), false);

    const audits = (await pool().query("SELECT action FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1", [String(t.id)])).rows.map((r) => r.action);
    assert.ok(audits.includes("helpdesk.ticket.follower_added") && audits.includes("helpdesk.ticket.follower_removed"));
  });

  test("the follow route answers the new rows; another team's agent gets 404", async () => {
    const t = await newTicket("Follow route");
    const on = await call(followRoute.POST, req(`http://localhost/api/helpdesk/tickets/${t.number}/follow`, U.agent2), { number: String(t.number) });
    assert.equal(on.status, 200);
    assert.equal(on.body.people.following, true);
    assert.ok(on.body.people.followers.some((f: { user_id: number }) => f.user_id === U.agent2.id));
    const off = await call(followRoute.DELETE, req(`http://localhost/api/helpdesk/tickets/${t.number}/follow`, U.agent2, undefined, "DELETE"), { number: String(t.number) });
    assert.equal(off.body.people.following, false);
    const no = await call(followRoute.POST, req(`http://localhost/api/helpdesk/tickets/${t.number}/follow`, U.outsider_agent), { number: String(t.number) });
    assert.equal(no.status, 404);
  });
});

// --- Merge helpers ----------------------------------------------------------------

describe("merge helpers", () => {
  test("moveCcs and moveFollowers union onto the kept ticket inside the caller's transaction", async () => {
    const from = await newTicket("Merge from");
    const keep = await newTicket("Merge keep");
    await ccs.addCcs(from.id, [{ userId: U.colleague.id }, { userId: U.stranger.id }, { email: OUTSIDE }], { userId: U.agent.id, via: "desk", outsideAllowed: true });
    await ccs.addCcs(keep.id, [{ userId: U.colleague.id }], { userId: U.agent.id, via: "desk" });
    await ccs.followTicket(from.id, U.agent2.id, { userId: U.agent2.id });
    await ccs.followTicket(keep.id, U.agent.id, { userId: U.agent.id });
    await ccs.unfollowTicket(keep.id, U.agent2.id, { userId: U.agent2.id });

    const moved = await dbCore.withTx(async (client) => {
      const a = await ccs.moveCcs(from.id, keep.id, client);
      const b = await ccs.moveFollowers(from.id, keep.id, client);
      // The requester of the source joins the kept ticket as a CC, with no side effects inside the transaction.
      const c = await ccs.addCcs(keep.id, [{ userId: U.req.id }, { userId: U.agent2.id }], { userId: U.agent.id, via: "merge" }, client);
      return { a, b, c };
    });
    assert.equal(moved.a, 2, "the colleague was already there");
    assert.equal(moved.b, 0, "a row on the kept ticket wins (the unfollow)");
    assert.deepEqual(moved.c.skipped.map((s) => s.reason), ["requester"], "the kept ticket's requester is never a CC");
    assert.equal((await ccs.listCcs(from.id)).length, 0);
    const kept = await ccs.listCcs(keep.id);
    assert.deepEqual(new Set(kept.map((c) => c.userId ?? c.email)), new Set([U.colleague.id, U.stranger.id, OUTSIDE, U.agent2.id]));
    assert.deepEqual((await ccs.listFollowers(keep.id)).map((f) => f.userId), [U.agent.id]);
    const audits = (await pool().query("SELECT count(*) FROM audit_log WHERE action = 'helpdesk.ticket.cc_added' AND target_id = $1 AND details->>'via' = 'merge'", [String(keep.id)])).rows[0];
    assert.equal(Number(audits.count), 0, "no audit from inside the merge's transaction");
  });
});

// --- 1.19.1 review fixes: one notice per person, only to people who may hear ----------

describe("one notice per person, and only to people who may hear it", () => {
  const BLOCKED = `${STAMP}-blocked@cust.example.test`;
  const extraUsers: number[] = [];
  const agentAuthor = () => ({ id: U.agent.id, name: U.agent.name, email: U.agent.email });
  /** Everyone a mail carrying `text` went to (To and Cc), lower-case. */
  const recipientsOf = (text: string) =>
    mail.filter((m) => m.text.includes(text)).flatMap((m) => [m.to, ...(m.cc ?? "").split(",")].map((a) => a.trim().toLowerCase()).filter(Boolean));
  const requestBells = async (userId: number, number: number) =>
    (await pool().query("SELECT title FROM notifications WHERE user_id = $1 AND link = $2", [userId, `/help/requests/${number}`])).rows.map((r) => r.title as string);

  before(async () => {
    const { saveUserNotifyPrefs, emptyPrefs } = await import("../src/lib/notify-policy");
    await saveUserNotifyPrefs(U.req.id, emptyPrefs());
  });

  after(async () => {
    ccs.setOutsideSendersForTests(null);
    await pool().query("DELETE FROM hd_portal_contacts WHERE email = $1", [BLOCKED]);
    if (extraUsers.length) await pool().query("DELETE FROM users WHERE id = ANY($1)", [extraUsers]);
  });

  test("outside senders off: outside CCs keep their rows and are mailed nothing; a blocked portal contact never is", async () => {
    const t = await newTicket("Outside off");
    await pool().query("INSERT INTO hd_portal_contacts (email, blocked) VALUES ($1, 1)", [BLOCKED]);
    ccs.setOutsideSendersForTests(true);
    const add = await ccs.addCcs(t.id, [{ email: OUTSIDE }, { email: BLOCKED }], { userId: U.agent.id, via: "desk" });
    assert.deepEqual(add.added.map((c) => c.email), [OUTSIDE]);
    assert.deepEqual(add.skipped.map((x) => x.reason), ["blocked"], "a blocked portal contact is not copied");
    // A row from before the block (or carried over by a merge) stays, and is never mailed.
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, NULL, $2, $2)", [t.id, BLOCKED]);

    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Reply while outside senders are on.", author: agentAuthor(), via: "desk" });
    await settle();
    const on = recipientsOf("Reply while outside senders are on.");
    assert.ok(on.includes(OUTSIDE), JSON.stringify(on));
    assert.ok(!on.includes(BLOCKED), "never the blocked contact");

    ccs.setOutsideSendersForTests(false);
    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Reply while outside senders are off.", author: agentAuthor(), via: "desk" });
    await settle();
    const off = recipientsOf("Reply while outside senders are off.");
    assert.ok(off.includes(U.req.email.toLowerCase()), `the requester still hears: ${JSON.stringify(off)}`);
    assert.ok(!off.includes(OUTSIDE) && !off.includes(BLOCKED), JSON.stringify(off));
    assert.ok((await ccs.listCcs(t.id)).some((c) => c.email === OUTSIDE), "the outside CC's row is kept for when it is turned back on");

    // The plan itself: nothing outside goes on Cc while off.
    const plan = await ccs.planCcNotice(t.id, "hd_desk_replied", U.agent.id);
    assert.deepEqual(plan.cc, []);
    ccs.setOutsideSendersForTests(null);
  });

  test("a CC's copy is nobody's personal mail: no manage link for the requester's settings", async () => {
    const t = await newTicket("Neutral copy");
    mail.length = 0;
    const vars = { ticket_number: String(t.number), subject: "x", author_name: "Ana", message: "Neutral copy body.", ticket_url: "/help/requests/1" };
    await email.sendHelpdeskTemplate(U.req.email, "hd_reply", vars, { ticketId: t.id, number: t.number }, "");
    await email.sendHelpdeskTemplate(U.req.email, "hd_reply", vars, { ticketId: t.id, number: t.number }, "", { cc: [OUTSIDE] });
    const [alone, group] = mail.slice(-2);
    assert.equal(group.cc, OUTSIDE);
    assert.match(alone.text, /Manage your notifications/, "the requester's own mail keeps its manage link");
    assert.doesNotMatch(group.text, /Manage your notifications/, "the group copy has none");
  });

  test("an agent who is a CC hears a requester's reply once (the desk notice), not again as a CC", async () => {
    const t = await newTicket("Agent CC");
    await ccs.addCcs(t.id, [{ userId: U.agent2.id }], { userId: U.req.id, via: "portal" });
    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Still broken after the reset.", author: { id: U.req.id, name: U.req.name, email: U.req.email }, via: "portal", asRequester: true });
    await settle();
    const toAgent2 = mail.filter((m) => m.text.includes("Still broken after the reset.") && [m.to, ...(m.cc ?? "").split(",")].map((a) => a.trim().toLowerCase()).includes(U.agent2.email.toLowerCase()));
    assert.ok(toAgent2.length <= 1, JSON.stringify(toAgent2.map((m) => [m.to, m.cc])));
    assert.ok(!toAgent2.some((m) => (m.cc ?? "").toLowerCase().includes(U.agent2.email.toLowerCase())), "not on Cc");
    assert.deepEqual((await requestBells(U.agent2.id, t.number)).filter((x) => /replied on/.test(x)), [], "no CC bell on top of the desk one");
    const desk = (await pool().query("SELECT count(*) FROM notifications WHERE user_id = $1 AND link = $2", [U.agent2.id, `/desk/tickets/${t.number}`])).rows[0];
    assert.ok(Number(desk.count) >= 1, "the desk notice reached them");
  });

  test("a CC never follows by writing, and a CC who follows hears a public reply once", async () => {
    const t = await newTicket("CC follower");
    await ccs.addCcs(t.id, [{ userId: U.agent2.id }], { userId: U.agent.id, via: "desk" });
    await messages.addMessage(t.id, { kind: "public", body: "The copied agent writes.", author: { id: U.agent2.id, name: U.agent2.name, email: U.agent2.email }, via: "desk" }, { silent: true });
    await settle();
    assert.equal(await ccs.isFollowing(t.id, U.agent2.id), false, "CCs never auto-follow");
    await ccs.followTicket(t.id, U.agent2.id, { userId: U.agent2.id, via: "desk" });
    followerHits.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Fixed on our side.", author: agentAuthor(), via: "desk" });
    await settle();
    assert.ok(!followerHits.some((h) => h.userId === U.agent2.id), "the CC notice covers a public reply");
    assert.ok((await requestBells(U.agent2.id, t.number)).some((x) => /replied on/.test(x)), "the CC notice went");
    followerHits.length = 0;
    await messages.addMessage(t.id, { kind: "internal", body: "For followers only.", author: agentAuthor(), via: "desk" });
    await settle();
    assert.ok(followerHits.some((h) => h.userId === U.agent2.id && /added a note/.test(h.title)), "a note still reaches the follower");
  });

  test("followers hear of a held reply when a lead approves it (never the lead who approved)", async () => {
    const t = await newTicket("Reviewed reply");
    const n = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Nia Newbie', $2, 'viewer', 'active') RETURNING id`, [
      `${STAMP}-newbie`,
      `${STAMP}-newbie@example.test`,
    ]);
    extraUsers.push(n.rows[0].id);
    await pool().query("UPDATE hd_team_members SET role = 'lead' WHERE team_id = $1 AND user_id = $2", [teamId, U.agent.id]);
    try {
      await ccs.followTicket(t.id, U.agent2.id, { userId: U.agent2.id, via: "desk" });
      await ccs.followTicket(t.id, U.agent.id, { userId: U.agent.id, via: "desk" });
      const m = await pool().query(
        `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, review_state)
         VALUES ($1, $2, 'Nia Newbie', $3, 'public', 'Held reply, now approved.', 'desk', 'pending') RETURNING id`,
        [t.id, n.rows[0].id, `${STAMP}-newbie@example.test`]
      );
      followerHits.length = 0;
      await review.decideReview({ id: U.agent.id, role: "viewer", name: U.agent.name } as never, m.rows[0].id, { decision: "approve" });
      await settle();
      assert.ok(followerHits.some((h) => h.userId === U.agent2.id && /replied on/.test(h.title)), JSON.stringify(followerHits));
      assert.ok(!followerHits.some((h) => h.userId === U.agent.id), "not the lead who approved it");
    } finally {
      await pool().query("UPDATE hd_team_members SET role = 'agent' WHERE team_id = $1 AND user_id = $2", [teamId, U.agent.id]);
    }
  });
});

// --- 1.19.1: a removed account's CC row kept for a legal hold ------------------------

describe("a removed account copied on a held ticket", () => {
  after(() => ccs.setOutsideSendersForTests(null));

  test("the row stays as a record, but nobody mails that address and its mail is not a CC's reply", async () => {
    const addr = `${STAMP}-erased@example.test`;
    const erased = (
      await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Erin Erased', $2, 'viewer', 'active') RETURNING id`, [
        `${STAMP}-erased`,
        addr,
      ])
    ).rows[0].id as number;
    const t = await newTicket("Held CC");
    await ccs.addCcs(t.id, [{ userId: erased }, { userId: U.colleague.id }], { userId: U.agent.id, via: "desk" });
    await pool().query("UPDATE hd_tickets SET legal_hold = 1 WHERE id = $1", [t.id]);
    const { deleteUser } = await import("../src/lib/db");
    assert.equal(await deleteUser(erased), true);

    const rows = (await pool().query("SELECT user_id, email, name, account_removed FROM hd_ticket_ccs WHERE ticket_id = $1 AND user_id IS NULL", [t.id])).rows;
    assert.deepEqual(rows, [{ user_id: null, email: addr, name: "Erin Erased", account_removed: true }], "the hold keeps the record, marked");
    assert.deepEqual((await ccs.listCcs(t.id)).map((c) => c.userId), [U.colleague.id], "not listed as a CC");
    assert.equal(await ccs.outsideCcByEmail(t.id, addr), undefined);
    assert.equal(await ccs.isCcAuthor(t.id, null, addr), false);
    assert.deepEqual((await ccs.ticketPeopleView(t.id, U.agent.id)).ccs.map((c) => c.user_id), [U.colleague.id]);
    const recordId = (await pool().query("SELECT id FROM hd_ticket_ccs WHERE ticket_id = $1 AND account_removed", [t.id])).rows[0].id;
    assert.equal(await ccs.removeCc(t.id, recordId, { userId: U.agent.id, via: "desk" }), undefined, "the record is not a CC to remove");
    const re = await ccs.addCcs(t.id, [{ email: addr }], { userId: U.agent.id, via: "desk", outsideAllowed: true });
    assert.equal(re.added.length, 0, "not copied back in as an outside address");

    // A public reply: the colleague is on Cc, the erased address nowhere (outside senders on for this process).
    ccs.setOutsideSendersForTests(true);
    const plan = await ccs.planCcNotice(t.id, "hd_desk_replied", U.agent.id);
    assert.ok(!plan.cc.includes(addr), JSON.stringify(plan));
    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "Held ticket reply.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" });
    await settle();
    const sent = mail.filter((m) => m.text.includes("Held ticket reply."));
    assert.ok(sent.length >= 1, "the requester is mailed");
    const everyone = sent.flatMap((m) => [m.to, ...(m.cc ?? "").split(",")].map((a) => a.trim().toLowerCase()));
    assert.ok(everyone.includes(U.colleague.email.toLowerCase()), JSON.stringify(everyone));
    assert.ok(!everyone.includes(addr), `nobody mails the removed account's address: ${JSON.stringify(everyone)}`);

    // Mail from that address on the thread is not a CC's reply: it opens a ticket of its own.
    const token = await email.ensureReplyToken(t.id);
    const before = Number((await pool().query("SELECT count(*) FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].count);
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: addr, name: "Erin Erased" }, subject: `Re: ${STAMP} Held CC [#${t.number} ref:${token}]`, text: "Still me." }),
      { outsideSenders: true }
    );
    assert.notEqual(r.body.outcome, "appended", JSON.stringify(r.body));
    assert.notEqual(r.body.ticket, t.number);
    if (r.body.ticket) ticketIds.push((await tickets.getTicketByNumber(r.body.ticket))!.id);
    assert.equal(Number((await pool().query("SELECT count(*) FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].count), before, "nothing added to the held ticket");
    await pool().query("UPDATE hd_tickets SET legal_hold = 0 WHERE id = $1", [t.id]);
  });
});

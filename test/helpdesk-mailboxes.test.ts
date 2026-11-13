// Helpdesk 1.20.2: several help addresses (lib/helpdesk/mailboxes).
//   - pure: which listed address a mail was sent to, for each provider's
//     payload (To, Cc, the envelope recipient, Delivered-To, plus-tagged
//     forms), the address rules, and a ticket's mailbox (its own, its
//     team's, the default);
//   - the upgrade seed from the 1.20.1 settings, and the two staying in step;
//   - add, edit, default, remove (a mailbox in use hands its tickets to the
//     default), with the audit rows;
//   - inbound: the ticket's mailbox and team (alias, then the mailbox's
//     team, then the first team), unknown recipients on the default, a reply
//     keeps its ticket's mailbox, our own addresses are never a requester or
//     a CC;
//   - outbound: From and Reply-To per mailbox, send-from off, the fallback
//     when the provider refuses the address (recorded and audited once),
//     agent notices unchanged;
//   - "Answer from" on the ticket and the admin routes' permissions, the
//     test send, and the additive `mailbox` field of the API and webhooks;
//   - 1.20.5, send-from addresses (lib/helpdesk/send-addresses): the upgrade
//     from the send_from switch (idempotent, the old column mirrored, a
//     1.20.4 binary's write adopted), the list and its limits, the pick on
//     a help address (and the old `send_from` write), the From name rule,
//     the refusal fallback and its one audit row per streak, removing an
//     address in use, and its own test send.
//
// hd_mailboxes and hd_send_addresses are workspace-wide: the whole file runs under the email
// settings' advisory lock (728351, as test/helpdesk-review-fixes-s2), with
// the mailboxes and the two old settings it found put back afterwards.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-mailboxes.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

// --- Request scope and licence stubs (as test/helpdesk-share.test.ts) -----------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-mailboxes.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-mailboxes.virtual.js");
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
const shared = require("../src/lib/helpdesk/mailboxes-shared") as typeof import("../src/lib/helpdesk/mailboxes-shared");
const mailboxes = require("../src/lib/helpdesk/mailboxes") as typeof import("../src/lib/helpdesk/mailboxes");
const sendAddresses = require("../src/lib/helpdesk/send-addresses") as typeof import("../src/lib/helpdesk/send-addresses");
const parse = require("../src/lib/helpdesk/inbound-parse") as typeof import("../src/lib/helpdesk/inbound-parse");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const ccs = require("../src/lib/helpdesk/ccs") as typeof import("../src/lib/helpdesk/ccs");
const settingsLib = require("../src/lib/helpdesk/settings") as typeof import("../src/lib/helpdesk/settings");
const seed = require("../src/lib/helpdesk/seed") as typeof import("../src/lib/helpdesk/seed");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const listRoute = require("../src/app/api/helpdesk/admin/mailboxes/route") as typeof import("../src/app/api/helpdesk/admin/mailboxes/route");
const oneRoute = require("../src/app/api/helpdesk/admin/mailboxes/[id]/route") as typeof import("../src/app/api/helpdesk/admin/mailboxes/[id]/route");
const testRoute = require("../src/app/api/helpdesk/admin/mailboxes/[id]/test/route") as typeof import("../src/app/api/helpdesk/admin/mailboxes/[id]/test/route");
const sendersRoute = require("../src/app/api/helpdesk/admin/send-addresses/route") as typeof import("../src/app/api/helpdesk/admin/send-addresses/route");
const senderRoute = require("../src/app/api/helpdesk/admin/send-addresses/[id]/route") as typeof import("../src/app/api/helpdesk/admin/send-addresses/[id]/route");
const senderTestRoute = require("../src/app/api/helpdesk/admin/send-addresses/[id]/test/route") as typeof import("../src/app/api/helpdesk/admin/send-addresses/[id]/test/route");
const agentRoute = require("../src/app/api/helpdesk/mailboxes/route") as typeof import("../src/app/api/helpdesk/mailboxes/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const settingsRoute = require("../src/app/api/helpdesk/admin/settings/route") as typeof import("../src/app/api/helpdesk/admin/settings/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { HdMailbox } from "../src/lib/helpdesk/mailboxes-shared";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdmb${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `${STAMP}.example.test`;
const A = `help@${DOMAIN}`;
const B = `billing@${DOMAIN}`;
const C = `press@${DOMAIN}`;
const TRANSPORT_FROM_RE = /<([^>]+)>$/;
const LOCK = 728351;
type Person = { id: number; email: string; session: string; name: string };
const U: Record<"req" | "agent" | "newbie" | "manager" | "solo", Person> = {} as never;
let teamA = 0;
let teamB = 0;
let teamAlias = 0;
const ALIAS = `${STAMP}-hr@example.test`;
const ticketIds: number[] = [];
const mail: HelpdeskOutgoingMail[] = [];
/** The transport refuses a From on these addresses (a provider that does not allow sending as them). */
const refuseFrom = new Set<string>();
/** Thrown by the transport's next send, once (a timeout, a "try again", a refused recipient). */
let failNext: Error | null = null;
/** Every send the transport was asked for, refused ones included. */
let attempts = 0;
let lockClient: PoolClient | null = null;
let savedBoxes: Record<string, unknown>[] = [];
let savedSenders: Record<string, unknown>[] = [];
let savedTickets: { id: number; mailbox_id: number }[] = [];
let savedSettings = { inbound_address: "", email_from_name: "", inbound_secret: "" };

const settle = () => new Promise((r) => setTimeout(r, 300));
// This process's connections carry the stamp as their application_name (node-postgres reads
// PGAPPNAME when the pool is built, on its first use), so a test can find its own waiting query.
process.env.PGAPPNAME = STAMP;
const MIRROR_LOCK_SQL = "SELECT value FROM settings WHERE key = $1 FOR UPDATE";
/** Whether one of this test's connections is waiting for a lock on the statement (polled for 5 s). */
async function waitingForSettings(sql = MIRROR_LOCK_SQL): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const r = await pool().query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query = $2", [STAMP, sql]);
    if (r.rowCount) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}
const bare = (from: string) => (from.match(TRANSPORT_FROM_RE)?.[1] ?? from).toLowerCase();

function req(url: string, who: Person | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.94",
    "user-agent": "MailboxTest/1.0",
    origin: "http://localhost",
    host: "localhost",
  };
  if (who) headers.cookie = `compass_session=${who.session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: (r: Request, ctx: any) => Promise<Response>, r: Request, params: Record<string, string> = {}) {
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

const BASE = "http://localhost/api/helpdesk/admin/mailboxes";
const by = () => ({ actor: { id: U.manager.id, name: U.manager.name, role: "viewer" } });

function inboundEmail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: `${newToken().slice(0, 10)}@customer.example.test`, name: "Cara Customer" },
    to: [{ email: A, name: "" }],
    cc: [],
    recipients: [],
    subject: `${STAMP} A question`,
    text: "Hello, could you help with my invoice?",
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

async function mailIn(over: Partial<InboundEmail> = {}) {
  inbound.resetInboundRateLimitsForTests();
  const res = await inbound.processInboundEmail(inboundEmail(over), { outsideSenders: true, trustUnverified: false });
  const number = res.body.ticket;
  const row = number
    ? (await pool().query("SELECT id, number, team_id, mailbox_id, requester_email, reply_token FROM hd_tickets WHERE number = $1", [number])).rows[0]
    : null;
  if (row && !ticketIds.includes(row.id)) ticketIds.push(row.id);
  return { res, row };
}

async function wipeMailboxes() {
  await pool().query("DELETE FROM hd_mailboxes");
  await pool().query("DELETE FROM hd_send_addresses");
  mailboxes.resetMailboxesReadyForTests();
}

/** The three addresses every later block works with: A (default, team A), B (team B, sends from itself), C (no team). */
async function threeBoxes(): Promise<{ a: HdMailbox; b: HdMailbox; c: HdMailbox }> {
  await wipeMailboxes();
  await settingsLib.saveHelpdeskSettings({ inbound_address: "" });
  const a = await mailboxes.createMailbox({ address: A, name: "Acme Help", team_id: teamA }, by());
  const b = await mailboxes.createMailbox({ address: B, name: "Acme Billing", team_id: teamB, send_from: true }, by());
  const c = await mailboxes.createMailbox({ address: C, name: "Acme Press" }, by());
  return { a, b, c };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
  // What the workspace had: put back in after().
  savedBoxes = (await pool().query("SELECT * FROM hd_mailboxes ORDER BY id")).rows;
  savedSenders = (await pool().query("SELECT * FROM hd_send_addresses ORDER BY id")).rows;
  savedTickets = (await pool().query("SELECT id, mailbox_id FROM hd_tickets WHERE mailbox_id IS NOT NULL")).rows;
  const s = await settingsLib.getHelpdeskSettings();
  savedSettings = { inbound_address: s.inbound_address, email_from_name: s.email_from_name, inbound_secret: s.inbound_secret };
  await pool().query("DELETE FROM hd_mailboxes");
  await pool().query("DELETE FROM hd_send_addresses");
  await settingsLib.saveHelpdeskSettings({ inbound_address: "", email_from_name: "Helpdesk", inbound_secret: s.inbound_secret || settingsLib.newInboundSecret() }, { syncMailboxes: false });

  // solo: an agent of team A only (the others below are in every team).
  const names = { req: "Daniel Okafor", agent: "Ana Kowalski", newbie: "Noor Haddad", manager: "Mina Park", solo: "Ilse Brandt" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const addr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'UTC') RETURNING id`, [
      `${STAMP}-${k}`,
      `${name} ${STAMP.slice(-4)}`,
      addr,
    ]);
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: addr, session, name: `${name} ${STAMP.slice(-4)}` };
  }
  for (const [k, role] of [["agent", "agent"], ["newbie", "newbie"], ["manager", "manager"], ["solo", "agent"]] as const) {
    await fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`,
      [U[k].id, role === "manager" ? "helpdesk-manager" : "helpdesk-agent"]
    );
    await fixtureQuery("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [U[k].id, role]);
  }
  teamA = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9950) RETURNING id", [`${STAMP} Support`])).rows[0].id;
  teamB = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9951) RETURNING id", [`${STAMP} Billing`])).rows[0].id;
  teamAlias = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 9952) RETURNING id", [`${STAMP} HR`, ALIAS])).rows[0].id;
  for (const t of [teamA, teamB, teamAlias]) {
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent')", [t, U.agent.id, U.newbie.id]);
  }
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [teamA, U.solo.id]);
  email.setHelpdeskTransportForTests(async (m) => {
    attempts++;
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    if (refuseFrom.has(bare(m.from))) {
      const e = new Error("Mail command failed: 553 5.7.1 Sender address rejected: not owned by user smtp@example.test") as Error & { response?: string };
      e.response = "553 5.7.1 Sender address rejected: not owned by user smtp@example.test";
      throw e;
    }
    mail.push(m);
  });
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  const ids = Object.values(U).map((u) => u.id);
  const teams = [teamA, teamB, teamAlias];
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR id = ANY($3) OR subject LIKE $4", [teams, ids, ticketIds, `${STAMP}%`])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_mailboxes");
  await pool().query("DELETE FROM hd_send_addresses");
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teams]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM audit_log WHERE target_type IN ('helpdesk_mailbox', 'helpdesk_send_address') AND target_label LIKE $1", [`%${DOMAIN}`]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  // The workspace's own send-from addresses, mailboxes and settings, as found.
  for (const b of savedSenders) {
    const cols = Object.keys(b);
    await pool().query(`INSERT INTO hd_send_addresses (${cols.join(", ")}) OVERRIDING SYSTEM VALUE VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => b[c]));
  }
  for (const b of savedBoxes) {
    const cols = Object.keys(b);
    await pool().query(
      `INSERT INTO hd_mailboxes (${cols.join(", ")}) OVERRIDING SYSTEM VALUE VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      cols.map((c) => (c === "team_id" ? null : b[c]))
    );
    if (b.team_id) await pool().query("UPDATE hd_mailboxes SET team_id = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM hd_teams WHERE id = $2)", [b.id, b.team_id]);
  }
  for (const t of savedTickets) await pool().query("UPDATE hd_tickets SET mailbox_id = $2 WHERE id = $1", [t.id, t.mailbox_id]).catch(() => undefined);
  await settingsLib.saveHelpdeskSettings(savedSettings, { syncMailboxes: false });
  mailboxes.resetMailboxesReadyForTests();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    lockClient.release();
  }
  await pool().end();
});

// --- Pure: addresses and recipients -------------------------------------------------

describe("mailboxes-shared", () => {
  const boxes = [
    { id: 1, address: "help@acme.test", team_id: 10, is_default: true },
    { id: 2, address: "billing@acme.test", team_id: 20, is_default: false },
    { id: 3, address: "press@acme.test", team_id: null, is_default: false },
  ];
  const TOKEN = "k7q2xz9m4pqa1b2c";

  test("an address as stored, and why one is refused", () => {
    assert.equal(shared.cleanMailboxAddress("  Help@Acme.Test "), "help@acme.test");
    assert.equal(shared.cleanMailboxAddress("help+it@acme.test"), null, "a plus tag would look like a reply address");
    assert.equal(shared.cleanMailboxAddress("not an address"), null);
    assert.equal(shared.cleanMailboxAddress("a@b"), null);
    assert.equal(shared.cleanMailboxAddress(5), null);
    assert.equal(shared.mailboxAddressProblem(""), "Enter the address people write to.");
    assert.match(shared.mailboxAddressProblem("help+x@acme.test"), /\+ tag/);
    assert.equal(shared.mailboxAddressProblem("nope"), "That is not an email address.");
    assert.equal(shared.mailboxAddressProblem("help@acme.test"), "");
    assert.equal(shared.cleanMailboxName('  Acme "Help" <desk>\r\n '), "Acme Help desk");
  });

  test("one address matches another whatever its case or plus tag", () => {
    assert.equal(shared.matchMailbox(boxes, "HELP@ACME.TEST")?.id, 1);
    assert.equal(shared.matchMailbox(boxes, `billing+hd-${TOKEN}@acme.test`)?.id, 2);
    assert.equal(shared.matchMailbox(boxes, "billing+anything@acme.test")?.id, 2);
    assert.equal(shared.matchMailbox(boxes, "billing@other.test"), undefined);
    assert.equal(shared.matchMailbox(boxes, "helpdesk@acme.test"), undefined);
    assert.equal(shared.isOwnMailboxAddress(boxes, "Press@acme.test"), true);
    assert.equal(shared.isOwnMailboxAddress(boxes, `unlisted+hd-${TOKEN}@elsewhere.test`), true, "any ticket reply address is ours");
    assert.equal(shared.isOwnMailboxAddress(boxes, "someone@acme.test"), false);
    assert.equal(shared.isOwnMailboxAddress(boxes, ""), false);
  });

  test("Postmark: To, Cc, OriginalRecipient and Delivered-To", () => {
    const base = { From: "Cara <cara@customer.test>", Subject: "Hi", TextBody: "Hello", MessageID: "m1" };
    const to = parse.parsePostmark({ ...base, ToFull: [{ Email: "Billing@Acme.test", Name: "Billing" }], To: "Billing@Acme.test" });
    assert.equal(shared.mailboxForRecipients(boxes, to)?.id, 2);
    const cc = parse.parsePostmark({ ...base, ToFull: [{ Email: "bob@customer.test", Name: "" }], CcFull: [{ Email: "press@acme.test", Name: "" }] });
    assert.equal(shared.mailboxForRecipients(boxes, cc)?.id, 3);
    // Forwarded to Postmark's own inbound address: only OriginalRecipient names ours (here with a reply tag).
    const env = parse.parsePostmark({ ...base, ToFull: [{ Email: "abc123@inbound.postmarkapp.com", Name: "" }], OriginalRecipient: `billing+hd-${TOKEN}@acme.test` });
    assert.equal(shared.mailboxForRecipients(boxes, env)?.id, 2);
    // On Bcc: nothing but the receiving server's Delivered-To header.
    const bcc = parse.parsePostmark({ ...base, ToFull: [{ Email: "bob@customer.test", Name: "" }], Headers: [{ Name: "Delivered-To", Value: "help@acme.test" }] });
    assert.equal(shared.mailboxForRecipients(boxes, bcc)?.id, 1);
    const none = parse.parsePostmark({ ...base, ToFull: [{ Email: "bob@customer.test", Name: "" }] });
    assert.equal(shared.mailboxForRecipients(boxes, none), undefined);
  });

  test("SendGrid: to, cc, the envelope and the raw headers", async () => {
    const form = (fields: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ from: "Cara <cara@customer.test>", subject: "Hi", text: "Hello", ...fields })) f.set(k, v);
      return f;
    };
    assert.equal(shared.mailboxForRecipients(boxes, await parse.parseSendgrid(form({ to: "Acme Press <press@acme.test>" })))?.id, 3);
    assert.equal(shared.mailboxForRecipients(boxes, await parse.parseSendgrid(form({ to: "bob@customer.test", cc: "billing@acme.test" })))?.id, 2);
    const env = await parse.parseSendgrid(form({ to: "undisclosed-recipients:;", envelope: JSON.stringify({ to: ["help@acme.test"], from: "cara@customer.test" }) }));
    assert.equal(shared.mailboxForRecipients(boxes, env)?.id, 1);
    const hdr = await parse.parseSendgrid(form({ to: "bob@customer.test", headers: "Received: x\nX-Original-To: billing@acme.test\nSubject: Hi\n" }));
    assert.equal(shared.mailboxForRecipients(boxes, hdr)?.id, 2);
  });

  test("Mailgun: To, recipient and message-headers", async () => {
    const form = (fields: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ from: "Cara <cara@customer.test>", sender: "cara@customer.test", subject: "Hi", "body-plain": "Hello", ...fields })) f.set(k, v);
      return f;
    };
    assert.equal(shared.mailboxForRecipients(boxes, await parse.parseMailgun(form({ To: "billing@acme.test", recipient: "billing@acme.test" })))?.id, 2);
    // A route that forwards a catch-all: the To header names someone else, `recipient` is ours.
    assert.equal(shared.mailboxForRecipients(boxes, await parse.parseMailgun(form({ To: "bob@customer.test", recipient: "press@acme.test" })))?.id, 3);
    assert.equal(shared.mailboxForRecipients(boxes, await parse.parseMailgun(form({ To: "bob@customer.test", recipient: "catchall@mg.acme.test" }))), undefined);
  });

  test("generic JSON: to, cc, recipients / envelope_to and headers; the order is the same for every copy", () => {
    const g = (b: Record<string, unknown>) => parse.parseGeneric({ from: "cara@customer.test", subject: "Hi", text: "Hello", ...b });
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "press@acme.test" }))?.id, 3);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", recipients: ["billing@acme.test"] }))?.id, 2);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", envelope_to: "help@acme.test" }))?.id, 1);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", headers: { "Delivered-To": "billing@acme.test" } }))?.id, 2);
    // To two of ours: each copy lands on the address it was delivered to (the envelope).
    const both = { to: "billing@acme.test, help@acme.test" };
    assert.equal(shared.mailboxForRecipients(boxes, g({ ...both, recipients: ["help@acme.test"] }))?.id, 1);
    assert.equal(shared.mailboxForRecipients(boxes, g({ ...both, recipients: ["billing@acme.test"] }))?.id, 2);
    // One delivery for both (the envelope names two of ours): To, then Cc, pick among those two only.
    assert.equal(shared.mailboxForRecipients(boxes, g({ ...both, recipients: ["help@acme.test", "billing@acme.test"] }))?.id, 2);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "press@acme.test", cc: "billing@acme.test", recipients: ["help@acme.test", "billing@acme.test"] }))?.id, 2);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", recipients: ["help@acme.test", "billing@acme.test"] }))?.id, 1, "nothing visible picks: the first the envelope names");
    // With no envelope: To beats Cc, Cc beats the recipient headers.
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "press@acme.test", cc: "billing@acme.test", headers: { "Delivered-To": "help@acme.test" } }))?.id, 3);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", cc: "billing@acme.test", headers: { "Delivered-To": "help@acme.test" } }))?.id, 2);
    assert.deepEqual(shared.recipientCandidates(g({ to: "A@x.test", cc: "b@x.test, a@x.test", recipients: ["c@x.test"] })), ["c@x.test", "a@x.test", "b@x.test"]);
    assert.equal(shared.mailboxForRecipients([], g({ to: "help@acme.test" })), undefined);
  });

  test("the sender can't choose the mailbox: the envelope beats To and Cc, and the recipient headers count only without one", () => {
    const g = (b: Record<string, unknown>) => parse.parseGeneric({ from: "mallory@customer.test", subject: "Hi", text: "Hello", ...b });
    // Delivered to the public help@, with another listed address written into To, Cc or a header.
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "billing@acme.test", recipients: ["help@acme.test"] }))?.id, 1);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", cc: "press@acme.test", envelope_to: "help@acme.test" }))?.id, 1);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", recipients: ["help@acme.test"], headers: { "X-Original-To": "billing@acme.test", "Delivered-To": "billing@acme.test" } }))?.id, 1);
    // The envelope is the provider's own inbound address (every listed address forwards to it): it
    // says nothing, To and Cc decide as before; a recipient header still never does.
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "billing@acme.test", recipients: ["abc123@inbound.provider.test"] }))?.id, 2);
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", recipients: ["abc123@inbound.provider.test"], headers: { "X-Original-To": "billing@acme.test" } })), undefined);
    assert.deepEqual(shared.recipientGroups(g({ to: "x@customer.test", recipients: ["help@acme.test"], headers: { "X-Original-To": "billing@acme.test" } })), {
      envelope: ["help@acme.test"],
      visible: ["x@customer.test"],
      headers: [],
    });
    // No envelope at all (Bcc through a provider that reports none): the headers are what is left.
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "x@customer.test", headers: { "X-Original-To": "billing@acme.test" } }))?.id, 2);
  });

  test("addresses are found in one pass, the same ones as before", () => {
    assert.deepEqual(shared.scanAddresses('"Acme, Billing" <Billing@Acme.test>, help@acme.test; rfc822;press@acme.test', 10), ["Billing@Acme.test", "help@acme.test", "press@acme.test"]);
    assert.deepEqual(shared.scanAddresses("a@b, a@b@c.test, @x.test, x@.test, y@z.test.", 10), ["b@c.test", "y@z.test"]);
    assert.deepEqual(shared.scanAddresses("one@x.test two@x.test"), ["one@x.test"], "at most `max`, one by default");
    assert.deepEqual(shared.scanAddresses("no address here", 10), []);
    assert.equal(parse.normalizeEmail("Priya Shah <Priya.Shah+x@Example.com>"), "priya.shah+x@example.com");
    assert.equal(parse.normalizeEmail("undisclosed-recipients:;"), "");
  });

  test("a huge recipient header costs nothing: values are cut, counted and read in one pass", () => {
    const KB300 = 300 * 1024;
    const shapes = {
      "no @ at all": "a".repeat(KB300),
      "an @ after every letter": "a@".repeat(KB300 / 2),
      "one endless domain": `x@${"a.".repeat(KB300 / 2)}`,
      "one endless local part": `${"a".repeat(KB300)}@`,
      "thousands of addresses": "someone@customer.test, ".repeat(Math.floor(KB300 / 23)),
    };
    for (const [name, value] of Object.entries(shapes)) {
      assert.ok(value.length >= KB300 - 30, name);
      const mails = [
        { to: [], cc: [], recipients: [], headers: { "x-original-to": value } },
        { to: [], cc: [], recipients: [], headerList: Array.from({ length: 500 }, (): [string, string] => ["delivered-to", value]) },
        { to: [{ email: value }], cc: [{ email: value }], recipients: [value] },
        { to: Array.from({ length: 5000 }, () => ({ email: value })), cc: [], recipients: Array.from({ length: 5000 }, () => value) },
      ];
      for (const m of mails) {
        const t0 = performance.now();
        assert.equal(shared.mailboxForRecipients(boxes, m), undefined);
        const ms = performance.now() - t0;
        // A wrong (rescanning) search takes seconds here; one second leaves room for a busy machine.
        assert.ok(ms < 1000, `${name}: ${ms.toFixed(1)} ms`);
        assert.ok(shared.recipientCandidates(m).length <= 3 * shared.RECIPIENT_LIMITS.addresses);
      }
      // The parser's own address search (From, To, Cc, the envelope fields) reads the same way.
      const t1 = performance.now();
      const parsed = parse.parseGeneric({ from: value, to: value, cc: [value, value], recipients: value, subject: "Hi", text: "Hello", headers: { "X-Original-To": value } });
      assert.equal(shared.mailboxForRecipients(boxes, parsed), undefined);
      const ms = performance.now() - t1;
      assert.ok(ms < 1000, `parse, ${name}: ${ms.toFixed(1)} ms`);
    }
    // Only the first 2,000 characters of a value and the first 50 values are read.
    const late = `${" ".repeat(shared.RECIPIENT_LIMITS.value)}billing@acme.test`;
    assert.equal(shared.mailboxForRecipients(boxes, { to: [], cc: [], recipients: [], headers: { "delivered-to": late } }), undefined);
    assert.equal(shared.mailboxForRecipients(boxes, { to: [], cc: [], recipients: [], headers: { "delivered-to": late.slice(20) } })?.id, 2);
    const many = Array.from({ length: 60 }, (_, i) => `r${i}@customer.test`);
    assert.equal(shared.mailboxForRecipients(boxes, { to: [], cc: [], recipients: [...many, "billing@acme.test"] }), undefined);
    assert.equal(shared.mailboxForRecipients(boxes, { to: [], cc: [], recipients: [...many.slice(0, 49), "billing@acme.test"] })?.id, 2);
    assert.equal(shared.recipientCandidates({ to: [], cc: [], recipients: [many.join(", ")] }).length, 50);
  });

  test("a ticket's mailbox: its own, else its team's, else the default", () => {
    assert.equal(shared.mailboxForTicket(boxes, { mailbox_id: 3, team_id: 20 })?.id, 3);
    assert.equal(shared.mailboxForTicket(boxes, { mailbox_id: null, team_id: 20 })?.id, 2);
    assert.equal(shared.mailboxForTicket(boxes, { mailbox_id: 99, team_id: 20 })?.id, 2, "a mailbox that is gone falls through");
    assert.equal(shared.mailboxForTicket(boxes, { mailbox_id: null, team_id: 77 })?.id, 1);
    assert.equal(shared.mailboxForTicket(boxes, {})?.id, 1);
    assert.equal(shared.mailboxForTicket([], { mailbox_id: 1 }), undefined);
  });

  test("every audit action has a label", () => {
    for (const k of ["created", "updated", "deleted", "tested", "send_from_failed"]) assert.ok(auditLabels.hasActionLabel(`helpdesk.mailbox.${k}`), k);
    for (const k of ["created", "updated", "deleted", "tested", "refused"]) assert.ok(auditLabels.hasActionLabel(`helpdesk.send_address.${k}`), k);
    assert.ok(auditLabels.hasActionLabel("helpdesk.ticket.mailbox_changed"));
  });
});

// --- Upgrade: the 1.20.1 settings -----------------------------------------------------

describe("upgrade from the single address", () => {
  test("no address set: nothing is seeded, mail goes out as before", async () => {
    await wipeMailboxes();
    await settingsLib.saveHelpdeskSettings({ inbound_address: "", email_from_name: "Old Desk" }, { syncMailboxes: false });
    assert.deepEqual(await mailboxes.listMailboxes(), []);
    const who = await mailboxes.outboundIdentity(null);
    assert.deepEqual(who, { mailboxId: null, name: "Old Desk", address: "", sendFrom: false });
    assert.equal(await mailboxes.mailboxForInbound(inboundEmail()), null);
  });

  test("the old address becomes the default mailbox, once, under the old name", async () => {
    await wipeMailboxes();
    await settingsLib.saveHelpdeskSettings({ inbound_address: `Help@${DOMAIN}`, email_from_name: "Acme IT desk" }, { syncMailboxes: false });
    mailboxes.resetMailboxesReadyForTests();
    const first = await mailboxes.listMailboxes();
    assert.equal(first.length, 1);
    assert.deepEqual(
      { address: first[0].address, name: first[0].name, is_default: first[0].is_default, send_from: first[0].send_from, team_id: first[0].team_id },
      { address: A, name: "Acme IT desk", is_default: true, send_from: false, team_id: null }
    );
    // A second boot (and a second process) seeds nothing more.
    mailboxes.resetMailboxesReadyForTests();
    assert.equal(await mailboxes.seedMailboxFromSettings(), null);
    assert.equal((await mailboxes.listMailboxes()).length, 1);
    // An upgrade changes nothing a requester sees: the same name, the workspace address, the same Reply-To.
    const who = await mailboxes.outboundIdentity(null);
    assert.deepEqual({ name: who.name, address: who.address, sendFrom: who.sendFrom }, { name: "Acme IT desk", address: A, sendFrom: false });
    // The setup checklist's Email step names it.
    assert.equal((await seed.setupChecklist()).steps.find((s) => s.key === "email")?.summary, A);
  });

  test("the old settings and the default mailbox stay one fact, both ways", async () => {
    const [box] = await mailboxes.listMailboxes();
    // The old settings API changes the address and the name: the same mailbox moves.
    const r = await call(settingsRoute.PATCH, req("http://localhost/api/helpdesk/admin/settings", U.manager, { inbound_address: `support@${DOMAIN}`, email_from_name: "Acme Support" }, "PATCH"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let now = await mailboxes.listMailboxes();
    assert.deepEqual(now.map((m) => [m.id, m.address, m.name, m.is_default]), [[box.id, `support@${DOMAIN}`, "Acme Support", true]]);
    // The Email page edits the mailbox: the old settings follow (a 1.20.1 binary reads the same).
    await mailboxes.updateMailbox(box.id, { address: A, name: "Acme Help" }, by());
    let s = await settingsLib.getHelpdeskSettings();
    assert.deepEqual([s.inbound_address, s.email_from_name], [A, "Acme Help"]);
    // A second address made the default: the settings name that one.
    const b = await mailboxes.createMailbox({ address: B, name: "Acme Billing", is_default: true }, by());
    s = await settingsLib.getHelpdeskSettings();
    assert.deepEqual([s.inbound_address, s.email_from_name], [B, "Acme Billing"]);
    // The old setting pointed at a listed address: it becomes the default, nothing is renamed.
    await settingsLib.saveHelpdeskSettings({ inbound_address: A });
    now = await mailboxes.listMailboxes();
    assert.deepEqual(now.map((m) => [m.address, m.is_default]), [[A, true], [B, false]]);
    // Clearing the old setting while several are listed removes nothing.
    await settingsLib.saveHelpdeskSettings({ inbound_address: "" });
    assert.equal((await mailboxes.listMailboxes()).length, 2);
    // Removing every address clears the old setting, so nothing is seeded back.
    await mailboxes.deleteMailbox(b.id, by());
    await mailboxes.deleteMailbox(box.id, by());
    assert.equal((await settingsLib.getHelpdeskSettings()).inbound_address, "");
    mailboxes.resetMailboxesReadyForTests();
    assert.deepEqual(await mailboxes.listMailboxes(), []);
    // And the old setting alone still makes the first one.
    await settingsLib.saveHelpdeskSettings({ inbound_address: A, email_from_name: "Acme Help" });
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => [m.address, m.name, m.is_default]), [[A, "Acme Help", true]]);
    await settingsLib.saveHelpdeskSettings({ inbound_address: "" });
    assert.deepEqual(await mailboxes.listMailboxes(), [], "the only address goes with the old setting");
  });

  test("a 1.20.1 address with a plus tag is listed without the tag, and still counts as ours", async () => {
    await wipeMailboxes();
    const TAGGED = `Company+Help@${DOMAIN}`;
    const base = `company@${DOMAIN}`;
    await settingsLib.saveHelpdeskSettings({ inbound_address: TAGGED, email_from_name: "Acme IT desk" }, { syncMailboxes: false });
    assert.equal(mailboxes.legacyMailboxAddress(TAGGED), base);
    assert.equal(mailboxes.legacyMailboxAddress("not an address"), null);
    assert.equal(mailboxes.legacyMailboxAddress(""), null);
    const seeded = await mailboxes.seedMailboxFromSettings();
    assert.deepEqual([seeded?.address, seeded?.name, seeded?.is_default], [base, "Acme IT desk", true]);
    mailboxes.resetMailboxesReadyForTests();
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => m.address), [base], "the Email page shows the address");
    const ours = await mailboxes.ownAddressMatcher();
    for (const a of [TAGGED, TAGGED.toLowerCase(), base, `company+hd-k7q2xz9m4pqa1b2c@${DOMAIN}`]) {
      assert.equal(await mailboxes.isOwnAddress(a), true, a);
      assert.equal(ours(a), true, a);
    }
    assert.equal(await mailboxes.isOwnAddress(`someone@${DOMAIN}`), false);
    // Mail to the tagged address lands on it, and replies come back to the same mailbox.
    assert.equal((await mailboxes.mailboxForInbound(inboundEmail({ to: [{ email: TAGGED.toLowerCase(), name: "" }] })))?.matched, true);
    assert.equal(email.replyToAddress(base, "k7q2xz9m4pqa1b2c"), `company+hd-k7q2xz9m4pqa1b2c@${DOMAIN}`);
    assert.equal(email.replyToAddress(TAGGED, "k7q2xz9m4pqa1b2c"), `company+hd-k7q2xz9m4pqa1b2c@${DOMAIN}`, "the Reply-To a requester saw in 1.20.1 is the same");
    // The old setting is left as 1.20.1 wrote it until the list changes.
    assert.equal((await settingsLib.getHelpdeskSettings()).inbound_address, TAGGED);
    // Without the seed (the list is empty and the setting names a tagged address): still ours.
    await pool().query("DELETE FROM hd_mailboxes");
    assert.equal(await mailboxes.isOwnAddress(TAGGED.toLowerCase()), true);
    assert.equal((await mailboxes.ownAddressMatcher())(base), true);
    await settingsLib.saveHelpdeskSettings({ inbound_address: "" }, { syncMailboxes: false });
    mailboxes.resetMailboxesReadyForTests();
  });

  test("a ticket whose help address was removed during intake is still created, without one", async () => {
    // Intake matched an address that is gone by the time the ticket is written (removed in between).
    const gone = 2_000_000_000;
    assert.equal((await pool().query("SELECT 1 FROM hd_mailboxes WHERE id = $1", [gone])).rowCount, 0);
    const t = await tickets.createTicket({ subject: `${STAMP} address removed`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, team_id: teamA, mailbox_id: gone } as never, { silent: true });
    ticketIds.push(t.id);
    assert.equal((await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].mailbox_id, null);
  });

  test("the old settings API: only an empty address clears; junk is refused and removes nothing", async () => {
    await wipeMailboxes();
    await settingsLib.saveHelpdeskSettings({ inbound_address: "" }, { syncMailboxes: false });
    const only = await mailboxes.createMailbox({ address: A, name: "Acme Help", team_id: teamA, send_from: true }, by());
    const t = await tickets.createTicket({ subject: `${STAMP} legacy api`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, team_id: teamA, mailbox_id: only.id } as never, { silent: true });
    ticketIds.push(t.id);
    const patch = (body: unknown) => call(settingsRoute.PATCH, req("http://localhost/api/helpdesk/admin/settings", U.manager, body, "PATCH"));
    const state = async () => ({
      boxes: (await mailboxes.listMailboxes()).map((m) => [m.id, m.address, m.name, m.team_id, m.send_from, m.is_default]),
      ticket: (await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].mailbox_id,
      setting: (await settingsLib.getHelpdeskSettings()).inbound_address,
      name: (await settingsLib.getHelpdeskSettings()).email_from_name,
    });
    const before = await state();
    assert.deepEqual(before, { boxes: [[only.id, A, "Acme Help", teamA, true, true]], ticket: only.id, setting: A, name: "Acme Help" });
    for (const [junk, why] of [
      [`help+x@${DOMAIN}`, /\+ tag/],
      ["help@", /not an email address/],
      [`Acme Help <${A}>`, /not an email address/],
      [`${A}, ${B}`, /not an email address/],
      [`${"a".repeat(200)}@${DOMAIN}`, /under 200 characters/],
      [5, /email address, or empty/],
      [null, /email address, or empty/],
    ] as const) {
      const r = await patch({ inbound_address: junk, email_from_name: "Renamed by a refused request" });
      assert.equal(r.status, 400, `${String(junk)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, why, String(junk));
      assert.deepEqual(await state(), before, `${String(junk)} changed something`);
    }
    // The stored value sent back as it is (a client that saves the whole form) is no change and no error.
    assert.equal((await patch({ inbound_address: A, csat_enabled: true })).status, 200);
    assert.deepEqual(await state(), before);
    // The library, called with junk by something other than the API: never "cleared", and a name in the same save still lands.
    await mailboxes.syncDefaultMailboxFromSettings({ inbound_address: "help@", email_from_name: "Acme Desk" }, ["inbound_address", "email_from_name"]);
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => [m.id, m.address, m.name]), [[only.id, A, "Acme Desk"]]);
    // Cleared while several are listed: nothing is removed, and the name in the same save still lands.
    const second = await mailboxes.createMailbox({ address: B, name: "Acme Billing" }, by());
    assert.equal((await patch({ inbound_address: "  ", email_from_name: "Acme Front Desk" })).status, 200);
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => [m.address, m.name]), [[A, "Acme Front Desk"], [B, "Acme Billing"]]);
    await mailboxes.deleteMailbox(second.id, by());
    assert.equal((await settingsLib.getHelpdeskSettings()).inbound_address, A);
    // Empty once trimmed, and it is the only one: that is "cleared".
    const cleared = await patch({ inbound_address: "   " });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual(await mailboxes.listMailboxes(), []);
    assert.equal((await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].mailbox_id, null);
  });

  test("the mirror into the old settings: with the mailbox change or not at all, and only its two keys", async () => {
    await wipeMailboxes();
    await settingsLib.saveHelpdeskSettings({ inbound_address: "" }, { syncMailboxes: false });
    const a = await mailboxes.createMailbox({ address: A, name: "Acme Help" }, by());
    const raw = async () => JSON.parse((await pool().query("SELECT value FROM settings WHERE key = 'helpdesk_settings'")).rows[0].value);
    assert.deepEqual([(await raw()).inbound_address, (await raw()).email_from_name], [A, "Acme Help"]);
    // A key this build does not know (a newer one wrote it) survives the mirror: only the two keys are replaced.
    const stored = await raw();
    await pool().query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [JSON.stringify({ ...stored, x_from_a_newer_build: { keep: true } })]);
    await mailboxes.updateMailbox(a.id, { name: "Acme Support" }, by());
    assert.deepEqual([(await raw()).email_from_name, (await raw()).x_from_a_newer_build, (await raw()).inbound_secret], ["Acme Support", { keep: true }, stored.inbound_secret]);
    await pool().query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [JSON.stringify(await raw().then(({ x_from_a_newer_build: _gone, ...rest }) => rest))]);

    // A settings save in flight (it holds the row, as saveHelpdeskSettings does): the mailbox change
    // waits for it, then writes its two keys into what that save stored. Nothing of that save is lost.
    const other = await pool().connect();
    let update: Promise<unknown> = Promise.resolve();
    try {
      await other.query("BEGIN");
      const cur = JSON.parse((await other.query("SELECT value FROM settings WHERE key = 'helpdesk_settings' FOR UPDATE")).rows[0].value);
      update = mailboxes.updateMailbox(a.id, { name: "Acme Front Desk" }, by());
      let done = false;
      void update.then(() => (done = true), () => (done = true));
      assert.equal(await waitingForSettings(), true, "the mirror waits for the settings row");
      assert.equal(done, false);
      assert.equal((await pool().query("SELECT name FROM hd_mailboxes WHERE id = $1", [a.id])).rows[0].name, "Acme Support", "and the mailbox change is not committed without it");
      await other.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [JSON.stringify({ ...cur, x_saved_meanwhile: "kept" })]);
      await other.query("COMMIT");
    } catch (e) {
      await other.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      other.release();
    }
    await update;
    const after = await raw();
    assert.deepEqual([after.inbound_address, after.email_from_name, after.x_saved_meanwhile, after.inbound_secret], [A, "Acme Front Desk", "kept", stored.inbound_secret]);
    // saveHelpdeskSettings takes the same lock, so it can't put an older address back either.
    const held = await pool().connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT 1 FROM settings WHERE key = 'helpdesk_settings' FOR UPDATE");
      let saved = false;
      const save = settingsLib.saveHelpdeskSettings({ email_from_name: "Acme Front Desk" }, { syncMailboxes: false }).then(() => (saved = true));
      assert.equal(await waitingForSettings("SELECT 1 FROM settings WHERE key = $1 FOR UPDATE"), true, "a settings save waits for the row too");
      assert.equal(saved, false);
      await held.query("COMMIT");
      await save;
    } finally {
      await held.query("ROLLBACK").catch(() => {});
      held.release();
    }
    await pool().query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [JSON.stringify(await raw().then(({ x_saved_meanwhile: _gone, ...rest }) => rest))]);

    // The mirror fails (its wait for the settings row is cancelled): the mailbox change is rolled back with it.
    const blocker = await pool().connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM settings WHERE key = 'helpdesk_settings' FOR UPDATE");
      const gone = mailboxes.deleteMailbox(a.id, by()).then(() => "deleted", (e: Error) => e.message);
      assert.equal(await waitingForSettings(), true);
      // Only this test's own connections (application_name) are cancelled.
      await pool().query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query = $2`, [STAMP, MIRROR_LOCK_SQL]);
      assert.match(await gone, /cancel/i);
      await blocker.query("ROLLBACK");
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => m.address), [A], "the address is still listed");
    assert.equal((await raw()).inbound_address, A, "and the old setting still names it");
    // And when it goes through, both go together: nothing to seed back on the next start.
    await mailboxes.deleteMailbox(a.id, by());
    assert.equal((await raw()).inbound_address, "");
    mailboxes.resetMailboxesReadyForTests();
    assert.deepEqual(await mailboxes.listMailboxes(), []);
  });
});

// --- Add, edit, default, remove -----------------------------------------------------

describe("the address list", () => {
  test("permissions: the email channel's capability, as the Email settings page", async () => {
    await wipeMailboxes();
    for (const who of [null, U.req, U.agent, U.newbie]) {
      const expected = who === null ? 401 : 403;
      assert.equal((await call(listRoute.GET, req(BASE, who, undefined, "GET"))).status, expected, `GET as ${who?.name}`);
      assert.equal((await call(listRoute.POST, req(BASE, who, { address: A, name: "x" }))).status, expected);
      assert.equal((await call(oneRoute.PATCH, req(`${BASE}/1`, who, { name: "x" }, "PATCH"), { id: "1" })).status, expected);
      assert.equal((await call(oneRoute.DELETE, req(`${BASE}/1`, who, undefined, "DELETE"), { id: "1" })).status, expected);
      assert.equal((await call(testRoute.POST, req(`${BASE}/1/test`, who), { id: "1" })).status, expected);
    }
    assert.deepEqual(await mailboxes.listMailboxes(), [], "nothing was written");
    // An agent reads the short list (the queue's filter); a requester does not.
    assert.equal((await call(agentRoute.GET, req("http://localhost/api/helpdesk/mailboxes", U.agent, undefined, "GET"))).status, 200);
    assert.notEqual((await call(agentRoute.GET, req("http://localhost/api/helpdesk/mailboxes", U.req, undefined, "GET"))).status, 200);
  });

  test("add: validation, the first is the default, duplicates in any case or with a tag are refused", async () => {
    const post = (b: unknown) => call(listRoute.POST, req(BASE, U.manager, b));
    assert.equal((await post({ address: "nope", name: "x" })).body.error, "That is not an email address.");
    assert.match((await post({ address: `help+it@${DOMAIN}`, name: "x" })).body.error, /\+ tag/);
    assert.match((await post({ address: A, name: "  " })).body.error, /Give the address a name/);
    assert.match((await post({ address: A, name: "x", team_id: 999999999 })).body.error, /team no longer exists/);
    assert.match((await post({ address: A, name: "x", send_from: "yes" })).body.error, /send_from is true or false/);
    const a = await post({ address: ` Help@${DOMAIN.toUpperCase()} `, name: "Acme Help", team_id: teamA, is_default: false });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual(
      { address: a.body.mailbox.address, name: a.body.mailbox.name, team_id: a.body.mailbox.team_id, is_default: a.body.mailbox.is_default, send_from: a.body.mailbox.send_from },
      { address: A, name: "Acme Help", team_id: teamA, is_default: true, send_from: false },
      "the first address is the default whatever was asked"
    );
    assert.equal((await post({ address: A.toUpperCase(), name: "Again" })).status, 409);
    const b = await post({ address: B, name: "Acme Billing", team_id: teamB, send_from: true });
    assert.equal(b.status, 201);
    assert.equal(b.body.mailbox.is_default, false);
    const list = await call(listRoute.GET, req(BASE, U.manager, undefined, "GET"));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.mailboxes.map((m: { address: string; team_name: string; tickets: number }) => [m.address, m.team_name, m.tickets]), [
      [A, `${STAMP} Support`, 0],
      [B, `${STAMP} Billing`, 0],
    ]);
    assert.equal(typeof list.body.mail_ready, "boolean");
    const audit = (await pool().query("SELECT action, details FROM audit_log WHERE target_type = 'helpdesk_mailbox' AND target_id = $1 ORDER BY id", [String(b.body.mailbox.id)])).rows;
    assert.deepEqual(audit.map((r) => r.action), ["helpdesk.mailbox.created"]);
    assert.deepEqual(audit[0].details, { address: B, name: "Acme Billing", team: `${STAMP} Billing`, send_address: B, is_default: false });
  });

  test("edit: one default at a time, never none; changes are audited from → to", async () => {
    const [a, b] = await mailboxes.listMailboxes();
    const patch = (id: number, body: unknown) => call(oneRoute.PATCH, req(`${BASE}/${id}`, U.manager, body, "PATCH"), { id: String(id) });
    assert.equal((await patch(a.id, { is_default: false })).status, 400, "the default can't just be switched off");
    assert.equal((await patch(b.id, { address: A })).status, 409);
    assert.equal((await patch(999999, { name: "x" })).status, 404);
    const r = await patch(b.id, { is_default: true, name: "Acme Accounts", team_id: null, send_from: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const now = await mailboxes.listMailboxes();
    assert.deepEqual(now.map((m) => [m.address, m.is_default]), [[A, false], [B, true]]);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_mailboxes WHERE is_default")).rows[0].n, 1);
    const row = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.mailbox.updated' AND target_label = $1 ORDER BY id DESC LIMIT 1", [B])).rows[0];
    assert.deepEqual(row.details.changes, {
      name: { from: "Acme Billing", to: "Acme Accounts" },
      team: { from: `${STAMP} Billing`, to: "No team (use routing)" },
      send_address: { from: B, to: "The workspace address" },
      is_default: { from: false, to: true },
    });
    // Nothing changed: no audit row.
    const before = (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.mailbox.updated' AND target_label = $1", [B])).rows[0].n;
    assert.equal((await patch(b.id, { name: "Acme Accounts" })).status, 200);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.mailbox.updated' AND target_label = $1", [B])).rows[0].n, before);
  });

  test("remove: an address in use hands its tickets to the default; removing the default promotes the next", async () => {
    const { a, b, c } = await threeBoxes();
    const mk = async (mailboxId: number | null) => {
      const t = await tickets.createTicket(
        { subject: `${STAMP} in use`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, team_id: teamA, mailbox_id: mailboxId } as never,
        { silent: true }
      );
      ticketIds.push(t.id);
      return t;
    };
    const [t1, t2, t3] = [await mk(b.id), await mk(b.id), await mk(a.id)];
    assert.equal(t1.mailbox_address, B, "the ticket reads with its address");
    const list = await call(listRoute.GET, req(BASE, U.manager, undefined, "GET"));
    assert.equal(list.body.mailboxes.find((m: { id: number }) => m.id === b.id).tickets, 2);
    const del = await call(oneRoute.DELETE, req(`${BASE}/${b.id}`, U.manager, undefined, "DELETE"), { id: String(b.id) });
    assert.deepEqual(del.body, { ok: true, moved: 2, moved_to: { id: a.id, address: A } });
    const rows = (await pool().query("SELECT id, mailbox_id FROM hd_tickets WHERE id = ANY($1) ORDER BY id", [[t1.id, t2.id, t3.id]])).rows;
    assert.deepEqual(rows.map((r) => r.mailbox_id), [a.id, a.id, a.id]);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.mailbox.deleted' AND target_id = $1", [String(b.id)])).rows[0];
    assert.deepEqual(audit.details, { address: B, tickets_moved: 2, moved_to: A, was_default: false });
    // The default goes: the next address in the list is the default, and takes its tickets.
    const gone = await mailboxes.deleteMailbox(a.id, by());
    assert.equal(gone?.moved, 3);
    assert.equal(gone?.moved_to?.id, c.id);
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => [m.address, m.is_default]), [[C, true]]);
    assert.equal((await settingsLib.getHelpdeskSettings()).inbound_address, C);
    // The last one: its tickets keep working with no address of their own.
    await mailboxes.deleteMailbox(c.id, by());
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE id = ANY($1) AND mailbox_id IS NOT NULL", [[t1.id, t2.id, t3.id]])).rows[0].n, 0);
    assert.equal((await call(oneRoute.DELETE, req(`${BASE}/${c.id}`, U.manager, undefined, "DELETE"), { id: String(c.id) })).status, 404);
  });
});

// --- Inbound --------------------------------------------------------------------------

describe("inbound: one webhook, any listed address", () => {
  let box: { a: HdMailbox; b: HdMailbox; c: HdMailbox };
  before(async () => {
    box = await threeBoxes();
  });

  test("the ticket lands on the address it was sent to, in that address's team", async () => {
    const toB = await mailIn({ to: [{ email: `Billing@${DOMAIN}`, name: "Billing" }] });
    assert.equal(toB.res.body.outcome, "created", JSON.stringify(toB.res.body));
    assert.deepEqual([toB.row.mailbox_id, toB.row.team_id], [box.b.id, teamB]);
    const toA = await mailIn({});
    assert.deepEqual([toA.row.mailbox_id, toA.row.team_id], [box.a.id, teamA]);
    // On Cc, or only in the envelope (Bcc, a provider's forward), or only in Delivered-To.
    const cc = await mailIn({ to: [{ email: "bob@customer.example.test", name: "" }], cc: [{ email: B, name: "" }] });
    assert.equal(cc.row.mailbox_id, box.b.id);
    const env = await mailIn({ to: [{ email: "abc@inbound.provider.test", name: "" }], recipients: [B] });
    assert.deepEqual([env.row.mailbox_id, env.row.team_id], [box.b.id, teamB]);
    const hdr = await mailIn({ to: [{ email: "bob@customer.example.test", name: "" }], headers: { "delivered-to": B } });
    assert.equal(hdr.row.mailbox_id, box.b.id);
    // Delivered to the public address with another one written into To and a header: the envelope decides.
    const forged = await mailIn({ to: [{ email: B, name: "" }], recipients: [A], headers: { "x-original-to": B } });
    assert.deepEqual([forged.row.mailbox_id, forged.row.team_id], [box.a.id, teamA]);
    const forgedHeader = await mailIn({ to: [{ email: "bob@customer.example.test", name: "" }], recipients: ["abc@inbound.provider.test"], headers: { "x-original-to": B } });
    assert.equal(forgedHeader.row.mailbox_id, box.a.id, "a header never picks while the provider reports an envelope: the default");
  });

  test("a recipient that is not listed counts as the default address", async () => {
    const r = await mailIn({ to: [{ email: `unknown@${DOMAIN}`, name: "" }] });
    assert.equal(r.res.body.outcome, "created");
    assert.deepEqual([r.row.mailbox_id, r.row.team_id], [box.a.id, teamA]);
  });

  test("team order: a team's email alias, then the mailbox's team, then the first team", async () => {
    // The alias wins over the mailbox's team; the ticket still remembers the address.
    const alias = await mailIn({ to: [{ email: B, name: "" }, { email: ALIAS, name: "" }] });
    assert.deepEqual([alias.row.mailbox_id, alias.row.team_id], [box.b.id, teamAlias]);
    // "No team (use routing)": the desk's first team, as before 1.20.2.
    const first = await inbound.teamForRecipients([]);
    const press = await mailIn({ to: [{ email: C, name: "" }] });
    assert.deepEqual([press.row.mailbox_id, press.row.team_id], [box.c.id, first]);
    assert.equal(await inbound.teamForRecipients([C], teamB), teamB);
    assert.equal(await inbound.teamForRecipients([ALIAS], teamB), teamAlias);
    assert.equal(await inbound.teamForRecipients([C], 999999999), first, "a team that is gone is no fallback");
  });

  test("a reply keeps its ticket's mailbox, whichever address it is sent to", async () => {
    const opened = await mailIn({ to: [{ email: B, name: "" }], from: { email: `${STAMP}-thread@customer.example.test`, name: "Tess" } });
    const token = (await email.ensureReplyToken(opened.row.id))!;
    const viaA = `help+hd-${token}@${DOMAIN}`;
    const re = await mailIn({ to: [{ email: viaA, name: "" }], from: { email: `${STAMP}-thread@customer.example.test`, name: "Tess" }, subject: `Re: ${STAMP} A question`, text: "Any news?" });
    assert.equal(re.res.body.outcome, "appended", JSON.stringify(re.res.body));
    assert.equal(re.res.body.ticket, opened.row.number);
    assert.equal(re.row.mailbox_id, box.b.id, "still the address it came in on");
    // A follow-up to the closed ticket, sent to a reply address: the thread's mailbox, not the default.
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now(), solved_at = now() WHERE id = $1", [opened.row.id]);
    const follow = await mailIn({ to: [{ email: `billing+hd-${token}@${DOMAIN}`, name: "" }], from: { email: `${STAMP}-thread@customer.example.test`, name: "Tess" }, text: "It broke again." });
    assert.equal(follow.res.body.outcome, "follow_up", JSON.stringify(follow.res.body));
    assert.equal(follow.row.mailbox_id, box.b.id);
    // …and when the mail names none of ours (the token is in the subject only): still the thread's.
    const bySubject = await mailIn({
      to: [{ email: "someone@elsewhere.example.test", name: "" }],
      from: { email: `${STAMP}-thread@customer.example.test`, name: "Tess" },
      subject: `Re: thing [#${opened.row.number} ref:${token}]`,
      text: "And again.",
    });
    assert.equal(bySubject.res.body.outcome, "follow_up");
    assert.equal(bySubject.row.mailbox_id, box.b.id);
  });

  test("loops: mail From one of our addresses is dropped only with a second sign that it is ours, and the drop is audited", async () => {
    const OURS = [A, B.toUpperCase(), `press+anything@${DOMAIN}`, `whatever+hd-k7q2xz9m4pqa1b2c@elsewhere.example.test`];
    const tickets_of = async (from: string) => (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE lower(requester_email) = lower($1)", [from])).rows[0].n;
    const drops = async (from: string) =>
      (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = $1 ORDER BY id", [from.toLowerCase()])).rows.map((r) => r.details);
    const signs: [string, Partial<InboundEmail>][] = [
      ["message_id", { messageId: "hd.k7q2xz9m4pqa1b2c.0a1b2c3d4e5f@mail.example.test" }],
      ["message_id", { messageId: "hd-note-k7q2xz9m4pqa1b2c-0a1b2c3d4e5f@mail.example.test" }],
      ["thread", { inReplyTo: "hd.k7q2xz9m4pqa1b2c.root@mail.example.test" }],
      ["thread", { references: ["someone@else.example.test", "<hd.k7q2xz9m4pqa1b2c.0a1b2c3d4e5f@mail.example.test>"] }],
      ["auto_submitted", { headers: { "auto-submitted": "auto-replied" } }],
    ];
    for (const from of OURS) {
      const before = await tickets_of(from);
      for (const [signal, over] of signs) {
        const r = await mailIn({ from: { email: from.toLowerCase(), name: "Acme" }, to: [{ email: B, name: "" }], ...over });
        assert.equal(r.res.body.outcome, "ignored_loop", `${from} ${signal}: ${JSON.stringify(r.res.body)}`);
      }
      assert.equal(await tickets_of(from), before);
      const rows = await drops(from);
      assert.deepEqual(rows.map((d) => d.signal), signs.map(([sig]) => sig), "every dropped mail leaves an audit row");
      assert.deepEqual(
        { reason: rows[0].reason, from: rows[0].from, provider: rows[0].provider, subject: rows[0].subject },
        { reason: "own_address_loop", from: from.toLowerCase(), provider: "generic", subject: `${STAMP} A question` }
      );
    }
    // The address alone is no loop: a colleague writing as the shared mailbox, or a group that
    // rewrites From, is real mail. It becomes a ticket like any other, and nothing is audited as dropped.
    for (const from of [A, `press+anything@${DOMAIN}`]) {
      const audited = (await drops(from)).length;
      const r = await mailIn({ from: { email: from, name: "Sam from Sales" }, to: [{ email: B, name: "" }], subject: `${STAMP} sent as the shared mailbox`, headers: { "auto-submitted": "no" } });
      assert.equal(r.res.body.outcome, "created", `${from}: ${JSON.stringify(r.res.body)}`);
      assert.deepEqual([r.row.requester_email, r.row.mailbox_id], [from, box.b.id]);
      assert.equal((await drops(from)).length, audited);
    }
    // A mail of somebody else with the same signs is not this guard's business (auto mail is ignored as before).
    const stranger = await mailIn({ inReplyTo: "hd.k7q2xz9m4pqa1b2c.root@mail.example.test" });
    assert.notEqual(stranger.res.body.outcome, "ignored_loop");
    // Our own header is still enough by itself, whoever it is From.
    const own = await mailIn({ headers: { "x-compassdocs-helpdesk": "1" } });
    assert.equal(own.res.body.outcome, "ignored_loop");
    assert.equal(inbound.ownMailSignal(inboundEmail()), null);
    assert.equal(await mailboxes.isOwnAddress(`someone@${DOMAIN}`), false);
    await pool().query("DELETE FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = ANY($1)", [OURS.map((x) => x.toLowerCase())]);
  });

  test("loops: our own addresses are never a CC, from a mail's Cc or added by hand", async () => {
    const r = await mailIn({
      to: [{ email: A, name: "" }],
      cc: [{ email: B, name: "Billing" }, { email: `press+x@${DOMAIN}`, name: "" }, { email: `${STAMP}-friend@customer.example.test`, name: "Fran" }],
    });
    const listed = (await pool().query("SELECT email FROM hd_ticket_ccs WHERE ticket_id = $1 ORDER BY email", [r.row.id])).rows.map((x) => x.email);
    assert.deepEqual(listed, [`${STAMP}-friend@customer.example.test`]);
    const added = await ccs.addCcs(r.row.id, [{ email: C }, { email: `billing+hd-k7q2xz9m4pqa1b2c@${DOMAIN}` }], { userId: U.agent.id, name: U.agent.name, via: "desk", outsideAllowed: true });
    assert.deepEqual(added.added, []);
    assert.deepEqual(added.skipped.map((s) => s.reason), ["own_address", "own_address"]);
  });
});

// --- Outbound ---------------------------------------------------------------------------

describe("outbound: every mail to the requester uses the ticket's mailbox", () => {
  let box: { a: HdMailbox; b: HdMailbox; c: HdMailbox };
  let transportFrom = "";
  const vars = { ticket_number: "1", subject: "x", requester_name: "Cara", team_name: "T", priority_label: "Normal", agent_name: "Ana", ticket_url: "/help/requests/1", message: "Hello", reply_excerpt: "Hello" };

  async function ticket(mailboxId: number | null, teamId: number | null) {
    const t = await tickets.createTicket(
      { subject: `${STAMP} outbound`, body: "x", requester: { id: null, name: "Cara Customer", email: `${STAMP}-cara@customer.example.test` }, team_id: teamId, mailbox_id: mailboxId, via: "email", source: "email" } as never,
      { silent: true }
    );
    ticketIds.push(t.id);
    return t;
  }
  async function send(t: { id: number; number: number; team_id: number | null }, to = `${STAMP}-cara@customer.example.test`) {
    mail.length = 0;
    const ok = await email.sendHelpdeskTemplate(to, "hd_reply", { ...vars, ticket_number: String(t.number) }, { ticketId: t.id, number: t.number, teamId: t.team_id });
    return { ok, m: mail[mail.length - 1], all: [...mail] };
  }

  before(async () => {
    box = await threeBoxes();
    refuseFrom.clear();
    mail.length = 0;
    await email.sendHelpdeskTemplate(`${STAMP}-probe@customer.example.test`, "hd_portal_link", { portal_name: "x", signin_url: "https://x.test/", minutes: "15", org_name: "x" }, null);
    transportFrom = bare(mail[0].from);
  });

  test("From and Reply-To per mailbox: the name always, the address only when it sends from it", async () => {
    const tb = await ticket(box.b.id, teamA);
    const b = await send(tb);
    assert.equal(b.ok, true);
    assert.equal(b.m.from, `"Acme Billing" <${B}>`, "send-from on: From the address itself");
    const token = (await email.ensureReplyToken(tb.id))!;
    assert.equal(b.m.replyTo, `billing+hd-${token}@${DOMAIN}`);
    assert.match(b.m.messageId!, new RegExp(`^<hd\\.${token}\\.`), "threading is unchanged");
    // Send-from off: the workspace's own address under the mailbox's name; replies still come back to the mailbox.
    const ta = await ticket(box.a.id, teamB);
    const a = await send(ta);
    assert.equal(a.m.from, `"Acme Help" <${transportFrom}>`);
    assert.equal(a.m.replyTo, `help+hd-${(await email.ensureReplyToken(ta.id))!}@${DOMAIN}`);
    assert.equal(a.all.length, 1);
  });

  test("a ticket with no address of its own: its team's mailbox, else the default", async () => {
    const team = await send(await ticket(null, teamB));
    assert.equal(team.m.from, `"Acme Billing" <${B}>`);
    assert.match(team.m.replyTo!, new RegExp(`^billing\\+hd-[a-z0-9]{16}@${DOMAIN.replace(/\./g, "\\.")}$`));
    const other = await send(await ticket(null, teamAlias));
    assert.equal(other.m.from, `"Acme Help" <${transportFrom}>`);
    assert.match(other.m.replyTo!, /^help\+hd-/);
    const none = await send(await ticket(null, null));
    assert.match(none.m.replyTo!, /^help\+hd-/);
  });

  test("the whole path: an agent's reply reaches the requester and the CC from the ticket's address", async () => {
    const t = await ticket(box.b.id, teamB);
    // A colleague copied on the request (an outside CC is mailed only while outside senders are on).
    await ccs.addCcs(t.id, [{ userId: U.req.id }], { userId: U.agent.id, name: U.agent.name, via: "desk" });
    await settle();
    mail.length = 0;
    await messages.addMessage(t.id, { kind: "public", body: "We have refunded the charge.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" }, { actorId: U.agent.id, actorName: U.agent.name });
    await settle();
    const out = mail.filter((m) => [m.to, ...(m.cc ?? "").split(",").map((x) => x.trim())].some((a) => a.endsWith("@customer.example.test") || a === U.req.email));
    assert.ok(out.length >= 1, JSON.stringify(mail.map((m) => [m.to, m.cc])));
    for (const m of out) {
      assert.equal(m.from, `"Acme Billing" <${B}>`, `${m.to}: ${m.from}`);
      assert.match(m.replyTo!, /^billing\+hd-/);
    }
    const reached = new Set(out.flatMap((m) => [m.to, ...(m.cc ?? "").split(",").map((x) => x.trim())]));
    assert.ok(reached.has(`${STAMP}-cara@customer.example.test`) && reached.has(U.req.email), [...reached].join(", "));
  });

  test("agent-only notices are unchanged: the workspace address under the default's name", async () => {
    const t = await ticket(box.b.id, teamB);
    mail.length = 0;
    assert.equal(await email.sendHelpdeskEmail(U.agent.id, "hd_assigned", { ticket_number: String(t.number) }), true);
    const m = mail[mail.length - 1];
    assert.equal(m.to, U.agent.email);
    assert.equal(m.from, `"Acme Help" <${transportFrom}>`);
    assert.match(m.replyTo!, /^help\+hd-/);
    // Mail that is about no ticket: the same.
    mail.length = 0;
    await email.sendHelpdeskTemplate(`${STAMP}-probe@customer.example.test`, "hd_portal_link", { portal_name: "x", signin_url: "https://x.test/", minutes: "15", org_name: "x" }, null);
    assert.equal(mail[0].from, `"Acme Help" <${transportFrom}>`);
    assert.equal(mail[0].replyTo, undefined);
    // A requester with an account gets the ticket's address too.
    const own = await tickets.createTicket({ subject: `${STAMP} mine`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, team_id: teamA, mailbox_id: box.b.id } as never, { silent: true });
    ticketIds.push(own.id);
    mail.length = 0;
    await email.sendHelpdeskEmail(U.req.id, "hd_reply", { ...vars, ticket_number: String(own.number) });
    assert.equal(mail[0].from, `"Acme Billing" <${B}>`);
  });

  test("the provider refuses the address: the mail still goes, from the workspace address, and it is recorded and audited once", async () => {
    const t = await ticket(box.b.id, teamB);
    // 1.20.5: the refusal is held against the send-from address the mailbox picked (here its own address).
    const sender = box.b.send_address_id!;
    const audits = async () => (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.send_address.refused' AND target_type = 'helpdesk_send_address' AND target_id = $1 ORDER BY id", [String(sender)])).rows;
    assert.equal((await audits()).length, 0);
    refuseFrom.add(B);
    const first = await send(t);
    assert.equal(first.ok, true, "the requester still gets the reply");
    assert.equal(first.all.length, 1, "sent once");
    assert.equal(first.m.from, `"Acme Billing" <${transportFrom}>`, "the mailbox's name over the workspace address");
    assert.match(first.m.replyTo!, /^billing\+hd-/, "answers still come back to the mailbox");
    let row = (await mailboxes.getMailbox(box.b.id))!;
    assert.match(row.send_from_error, /553 5\.7\.1 Sender address rejected/);
    assert.ok(row.send_from_error_at);
    assert.equal(row.send_from, true, "the choice is the admin's: it is not switched off");
    const second = await send(t);
    assert.equal(second.m.from, `"Acme Billing" <${transportFrom}>`);
    const logged = await audits();
    assert.equal(logged.length, 1, "one audit row for the streak, not one per mail");
    assert.deepEqual(logged[0].details, { address: B, error: "553 5.7.1 Sender address rejected: not owned by user smtp@example.test", sent_from: "workspace address", help_address: B });
    // The 1.20.2 columns carry the same for a 1.20.4 binary on this database.
    const old = (await pool().query("SELECT send_from, send_from_error FROM hd_mailboxes WHERE id = $1", [box.b.id])).rows[0];
    assert.deepEqual([old.send_from, /Sender address rejected/.test(old.send_from_error)], [true, true]);
    // The provider accepts it again: the warning clears, and a later refusal is a new streak.
    refuseFrom.clear();
    const ok = await send(t);
    assert.equal(ok.m.from, `"Acme Billing" <${B}>`);
    row = (await mailboxes.getMailbox(box.b.id))!;
    assert.deepEqual([row.send_from_error, row.send_from_error_at], ["", null]);
    refuseFrom.add(B);
    await send(t);
    assert.equal((await audits()).length, 2);
    // Nothing gets through at all: the send fails as it always did, and no mailbox is blamed for it.
    refuseFrom.add(transportFrom);
    const dead = await send(t);
    assert.equal(dead.ok, false);
    assert.equal(dead.all.length, 0);
    refuseFrom.clear();
    await sendAddresses.clearSendAddressFailure(sender);
    assert.equal((await pool().query("SELECT send_from_error FROM hd_mailboxes WHERE id = $1", [box.b.id])).rows[0].send_from_error, "", "the old column is cleared with it");
  });

  test("only a permanent refusal of the address falls back: a timeout, a 4xx or a refused recipient fails as it always did, sent once", async () => {
    const smtp = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
    const cases: [string, Error, boolean][] = [
      ["a timeout", smtp("Connection timeout", { code: "ETIMEDOUT", command: "CONN" }), false],
      ["the socket closed after DATA", smtp("Connection closed unexpectedly", { code: "ECONNECTION", command: "DATA" }), false],
      ["try again later", smtp("Mail command failed: 451 4.7.1 Greylisted, try again later", { code: "EENVELOPE", command: "MAIL FROM", responseCode: 451, response: "451 4.7.1 Greylisted, try again later" }), false],
      ["an unknown recipient", smtp("Can't send mail - all recipients were rejected: 550 5.1.1 User unknown", { code: "EENVELOPE", command: "RCPT TO", responseCode: 550, response: "550 5.1.1 <x@customer.example.test>: Recipient address rejected: User unknown" }), false],
      ["a login failure", smtp("Invalid login: 535 5.7.8 Authentication failed", { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, response: "535 5.7.8 Authentication failed" }), false],
      ["5xx at MAIL FROM", smtp("Mail command failed: 550 5.1.0 Address rejected", { code: "EENVELOPE", command: "MAIL FROM", responseCode: 550, response: "550 5.1.0 Address rejected" }), true],
      ["5xx at DATA", smtp("Message failed: 554 Message rejected: Email address is not verified.", { code: "EMESSAGE", command: "DATA", responseCode: 554, response: "554 Message rejected: Email address is not verified." }), true],
      ["Postfix names the sender at RCPT TO", smtp("Can't send mail - all recipients were rejected: 553 5.7.1 Sender address rejected", { code: "EENVELOPE", command: "RCPT TO", responseCode: 553, response: `553 5.7.1 <${B}>: Sender address rejected: not owned by user smtp@example.test` }), true],
      ["Exchange: send as denied", smtp("Message failed: 554 5.2.252 SendAsDenied; smtp@example.test not allowed to send as billing", { responseCode: 554, response: "554 5.2.252 SendAsDenied; smtp@example.test not allowed to send as billing" }), true],
      ["only the text to go by", smtp("Mail command failed: 550 The from address does not match a verified Sender Identity", {}), true],
    ];
    for (const [name, e, sender] of cases) assert.equal(email.isSenderRejection(e), sender, name);
    assert.equal(email.isSenderRejection(new Error("something else")), false);
    assert.equal(email.isSenderRejection(null), false);

    const t = await ticket(box.b.id, teamB);
    const senderId = box.b.send_address_id!;
    await sendAddresses.clearSendAddressFailure(senderId);
    const audits = async () => (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.send_address.refused' AND target_id = $1", [String(senderId)])).rows[0].n;
    const auditsBefore = await audits();
    for (const [name, e, sender] of cases) {
      attempts = 0;
      failNext = e;
      const r = await send(t);
      if (sender) {
        assert.equal(r.ok, true, name);
        assert.equal(attempts, 2, `${name}: refused once, then sent from the workspace address`);
        assert.equal(r.m.from, `"Acme Billing" <${transportFrom}>`, name);
        assert.notEqual((await mailboxes.getMailbox(box.b.id))!.send_from_error, "", name);
        await sendAddresses.clearSendAddressFailure(senderId);
      } else {
        assert.equal(r.ok, false, `${name}: the send fails`);
        assert.equal(attempts, 1, `${name}: no second send (the first may have gone through)`);
        assert.equal(r.all.length, 0, name);
        assert.deepEqual([(await mailboxes.getMailbox(box.b.id))!.send_from_error, (await mailboxes.getMailbox(box.b.id))!.send_from_error_at], ["", null], `${name}: nothing is held against the address`);
      }
    }
    assert.equal((await audits()) - auditsBefore, cases.filter((c) => c[2]).length, "an audit row for each refusal of the address, none for the rest");
    // Send test: the provider's words come back either way; only a refusal of the address is kept on
    // the mailbox. (One call through the route: it allows five a minute per person.)
    failNext = cases[3][1];
    const bad = await call(testRoute.POST, req(`${BASE}/${box.b.id}/test`, U.manager), { id: String(box.b.id) });
    assert.deepEqual(bad.body, { ok: false, to: U.manager.email, from: B, error: "550 5.1.1 <x@customer.example.test>: Recipient address rejected: User unknown" });
    assert.equal((await mailboxes.getMailbox(box.b.id))!.send_from_error, "", "a refused recipient says nothing about the address");
    await pool().query("DELETE FROM audit_log WHERE action = 'helpdesk.mailbox.tested' AND target_id = $1", [String(box.b.id)]);
    failNext = cases[0][1];
    assert.deepEqual(await email.sendMailboxTestMail(box.b, U.manager.email), { ok: false, from: B, error: "Connection timeout", senderRejected: false });
    failNext = cases[6][1];
    assert.deepEqual(await email.sendMailboxTestMail(box.b, U.manager.email), { ok: false, from: B, error: "554 Message rejected: Email address is not verified.", senderRejected: true });
    failNext = null;
  });

  test("Send test: to the admin's own address, as a reply would leave, and the provider's refusal comes back plainly", async () => {
    const post = (id: number, who = U.manager) => call(testRoute.POST, req(`${BASE}/${id}/test`, who), { id: String(id) });
    mail.length = 0;
    const b = await post(box.b.id);
    assert.deepEqual(b.body, { ok: true, to: U.manager.email, from: B });
    assert.deepEqual([mail[0].to, mail[0].from, mail[0].replyTo, mail[0].subject], [U.manager.email, `"Acme Billing" <${B}>`, B, `Test from ${B}`]);
    assert.equal(mail[0].headers["X-CompassDocs-Helpdesk"], "1", "a test that comes back in is dropped as our own");
    const a = await post(box.a.id);
    assert.deepEqual(a.body, { ok: true, to: U.manager.email, from: transportFrom });
    assert.equal(mail[1].from, `"Acme Help" <${transportFrom}>`);
    refuseFrom.add(B);
    mail.length = 0;
    const refused = await post(box.b.id);
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.body, { ok: false, to: U.manager.email, from: B, error: "553 5.7.1 Sender address rejected: not owned by user smtp@example.test" });
    assert.equal(mail.length, 0, "no fallback on a test: the refusal is the answer");
    assert.match((await mailboxes.getMailbox(box.b.id))!.send_from_error, /Sender address rejected/);
    refuseFrom.clear();
    assert.equal((await post(box.b.id)).body.ok, true);
    assert.equal((await mailboxes.getMailbox(box.b.id))!.send_from_error, "", "a test that goes through clears the warning");
    assert.equal((await post(999999)).status, 404);
    const tested = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.mailbox.tested' AND target_id = $1 ORDER BY id", [String(box.b.id)])).rows;
    assert.deepEqual(tested.map((r) => r.details.result), ["sent", "refused", "sent"]);
  });
});

// --- The ticket: Answer from, and its shape ------------------------------------------------

describe("the ticket", () => {
  let box: { a: HdMailbox; b: HdMailbox; c: HdMailbox };
  let t: Awaited<ReturnType<typeof tickets.createTicket>>;
  const url = (n: number) => `http://localhost/api/helpdesk/tickets/${n}`;
  const patch = (who: Person, body: unknown) => call(ticketRoute.PATCH, req(url(t.number), who, body, "PATCH"), { number: String(t.number) });
  const get = (who: Person) => call(ticketRoute.GET, req(url(t.number), who, undefined, "GET"), { number: String(t.number) });

  before(async () => {
    box = await threeBoxes();
    t = await tickets.createTicket(
      { subject: `${STAMP} answer from`, body: "x", requester: { id: null, name: "Cara Customer", email: `${STAMP}-cara2@customer.example.test` }, team_id: teamB, via: "email", source: "email" } as never,
      { silent: true }
    );
    ticketIds.push(t.id);
  });

  test("the detail names the address in use and offers the choices", async () => {
    const d = await get(U.agent);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.mailbox, { id: box.b.id, address: B, name: "Acme Billing", own: false }, "no address of its own: its team's");
    assert.deepEqual(d.body.mailboxes.map((m: { address: string }) => m.address), [A, B, C]);
    assert.equal(d.body.can_change_mailbox, true);
    assert.equal((await get(U.newbie)).body.can_change_mailbox, false, "a reply-after-review role doesn't choose the address");
  });

  test("Answer from is the agent's own teams': the choices, the short list and the change are scoped alike", async () => {
    const list = async (who: Person) => (await call(agentRoute.GET, req("http://localhost/api/helpdesk/mailboxes", who, undefined, "GET"))).body.mailboxes.map((m: { address: string }) => m.address);
    // A is the default (team A), B is team B's, C has no team. solo is in team A only.
    assert.deepEqual(await mailboxes.mailboxScope({ id: U.solo.id, role: "viewer" }), [teamA]);
    assert.equal(await mailboxes.mailboxScope({ id: U.manager.id, role: "viewer" }), "all", "tickets.view_all reads and answers from any");
    assert.deepEqual(await list(U.solo), [A, C], "another team's address is not listed");
    assert.deepEqual(await list(U.agent), [A, B, C], "an agent of every team sees them all");
    assert.deepEqual(await list(U.manager), [A, B, C]);
    assert.equal(mailboxes.mailboxInScope({ is_default: true, team_id: teamB }, [teamA]), true, "the default is everyone's, whatever its team");
    assert.equal(mailboxes.mailboxInScope({ is_default: false, team_id: null }, []), true);
    assert.equal(mailboxes.mailboxInScope({ is_default: false, team_id: teamB }, [teamA]), false);

    // A team A ticket that came in on team B's address (it was moved to team A).
    const own = await tickets.createTicket(
      { subject: `${STAMP} scoped`, body: "x", requester: { id: null, name: "Cara Customer", email: `${STAMP}-cara3@customer.example.test` }, team_id: teamA, mailbox_id: box.b.id, via: "email", source: "email" } as never,
      { silent: true }
    );
    ticketIds.push(own.id);
    const at = (who: Person, body?: unknown) =>
      body === undefined
        ? call(ticketRoute.GET, req(url(own.number), who, undefined, "GET"), { number: String(own.number) })
        : call(ticketRoute.PATCH, req(url(own.number), who, body, "PATCH"), { number: String(own.number) });
    const stored = async () => (await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [own.id])).rows[0].mailbox_id;
    const trail = async () => [
      (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%answered from%'", [own.id])).rows[0].n,
      (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.ticket.mailbox_changed' AND target_id = $1", [String(own.id)])).rows[0].n,
    ];
    let d = (await at(U.solo)).body;
    assert.deepEqual(d.mailbox, { id: box.b.id, address: B, name: "Acme Billing", own: true }, "the address in use is always named");
    assert.deepEqual(d.mailboxes.map((m: { address: string }) => m.address), [A, C], "the choices are the agent's own");
    assert.equal(d.can_change_mailbox, true, "they may move it to one of theirs");
    // The other team's address is refused, by id as well as left out of the list; nothing is written.
    await pool().query("UPDATE hd_tickets SET mailbox_id = NULL WHERE id = $1", [own.id]);
    const refused = await at(U.solo, { mailbox_id: box.b.id });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error, /belongs to another team/);
    assert.equal(await stored(), null);
    assert.deepEqual(await trail(), [0, 0]);
    assert.deepEqual(await mailboxes.changeAnswerFrom({ id: U.solo.id, name: U.solo.name, role: "viewer" }, own, box.b.id), { error: "That address belongs to another team. Answer from one of your own teams' addresses, or the default.", status: 403 });
    // Their own team's (the default here) and one with no team are theirs to choose.
    assert.deepEqual((await at(U.solo, { mailbox_id: box.c.id })).body.changed, ["mailbox_id"]);
    assert.equal(await stored(), box.c.id);
    assert.deepEqual((await at(U.solo, { mailbox_id: box.a.id })).body.changed, ["mailbox_id"]);
    assert.deepEqual((await at(U.solo, { mailbox_id: null })).body.changed, [], "back to working it out: the same address, nothing to tell");
    // Someone who sees every team's tickets may answer from any address; so may an agent of that team.
    assert.deepEqual((await at(U.manager, { mailbox_id: box.b.id })).body.changed, ["mailbox_id"]);
    assert.equal(await stored(), box.b.id);
    assert.deepEqual((await at(U.agent, { mailbox_id: box.c.id })).body.changed, ["mailbox_id"]);
    assert.deepEqual((await at(U.agent, { mailbox_id: box.b.id })).body.changed, ["mailbox_id"]);
    // Nothing else to choose: the address is a plain label. (C becomes team B's: solo is left with A only.)
    await pool().query("UPDATE hd_mailboxes SET team_id = $2 WHERE id = $1", [box.c.id, teamB]);
    try {
      d = (await at(U.solo)).body;
      assert.deepEqual([d.mailbox.address, d.mailboxes.map((m: { address: string }) => m.address), d.can_change_mailbox], [B, [A], true], "on another team's address: named, and A is the one move open");
      await pool().query("UPDATE hd_tickets SET mailbox_id = $2 WHERE id = $1", [own.id, box.a.id]);
      d = (await at(U.solo)).body;
      assert.deepEqual([d.mailbox.address, d.mailboxes.map((m: { address: string }) => m.address), d.can_change_mailbox], [A, [A], false], "read-only: there is no other address to choose");
      assert.equal((await at(U.solo, { mailbox_id: box.c.id })).status, 403);
      assert.deepEqual(await list(U.solo), [A]);
    } finally {
      await pool().query("UPDATE hd_mailboxes SET team_id = NULL WHERE id = $1", [box.c.id]);
    }
  });

  test("an agent changes Answer from: stored, a timeline line for agents, audited; refusals change nothing", async () => {
    assert.equal((await patch(U.newbie, { mailbox_id: box.c.id })).status, 403);
    assert.equal((await patch(U.manager, { mailbox_id: 999999999 })).status, 400);
    assert.equal((await patch(U.manager, { mailbox_id: "x" })).status, 400);
    assert.equal((await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].mailbox_id, null);
    const r = await patch(U.manager, { mailbox_id: box.c.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.changed, ["mailbox_id"]);
    assert.equal(r.body.ticket.mailbox_address, C);
    const d = await get(U.agent);
    assert.deepEqual(d.body.mailbox, { id: box.c.id, address: C, name: "Acme Press", own: true });
    const line = (await pool().query("SELECT kind, via, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual([line.kind, line.via], ["internal", "system"]);
    assert.match(line.body, /changed the address this ticket is answered from/);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.mailbox_changed' AND target_id = $1", [String(t.id)])).rows;
    assert.deepEqual(audit.map((a) => a.details), [{ number: t.number, from: B, to: C }]);
    // The next mail to the requester leaves from it.
    mail.length = 0;
    await email.sendHelpdeskTemplate(`${STAMP}-cara2@customer.example.test`, "hd_reply", { ticket_number: String(t.number), subject: "x", requester_name: "Cara", team_name: "T", priority_label: "Normal", agent_name: "Ana", ticket_url: "/x", message: "Hello", reply_excerpt: "Hello" }, { ticketId: t.id, number: t.number, teamId: t.team_id });
    assert.match(mail[0].from, /^"Acme Press" </);
    assert.match(mail[0].replyTo!, /^press\+hd-/);
    // The same choice again, and with another field: one line, one audit row.
    assert.deepEqual((await patch(U.manager, { mailbox_id: box.c.id })).body.changed, []);
    const both = await patch(U.manager, { mailbox_id: box.a.id, priority: "high" });
    assert.deepEqual(both.body.changed.sort(), ["mailbox_id", "priority"]);
    // Back to "work it out": the team's again.
    assert.deepEqual((await patch(U.manager, { mailbox_id: null })).body.changed, ["mailbox_id"]);
    assert.deepEqual((await get(U.agent)).body.mailbox, { id: box.b.id, address: B, name: "Acme Billing", own: false });
  });

  test("a refused PATCH changes nothing: the address is stored last, after every other check and the other fields", async () => {
    const before = (await pool().query("SELECT mailbox_id, priority, team_id, status FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    const target = before.mailbox_id === box.c.id ? box.a.id : box.c.id;
    const trail = async () => [
      (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].n,
      (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.ticket.mailbox_changed' AND target_id = $1", [String(t.id)])).rows[0].n,
    ];
    const trailBefore = await trail();
    const same = async (why: string) => {
      assert.deepEqual((await pool().query("SELECT mailbox_id, priority, team_id, status FROM hd_tickets WHERE id = $1", [t.id])).rows[0], before, why);
      assert.deepEqual(await trail(), trailBefore, `${why}: no timeline line, no audit row`);
    };
    // (As a manager: moving and assigning are theirs to do, so these get as far as the update.)
    // The team does not exist: refused inside the update itself.
    const noTeam = await patch(U.manager, { mailbox_id: target, team_id: 999999999 });
    assert.equal(noTeam.status, 400, JSON.stringify(noTeam.body));
    assert.match(noTeam.body.error, /team does not exist/);
    await same("an unknown team");
    // Not an agent of that team: refused inside the update too.
    const noAgent = await patch(U.manager, { mailbox_id: target, assignee_id: U.req.id });
    assert.equal(noAgent.status, 400, JSON.stringify(noAgent.body));
    await same("an assignee who is not an agent");
    // A bad address in a request that is otherwise fine: the other field is not saved either.
    const badBox = await patch(U.manager, { mailbox_id: 999999999, priority: before.priority === "urgent" ? "low" : "urgent" });
    assert.equal(badBox.status, 400);
    await same("an address that is not listed");
    // And when all of it passes, both land, the address after the rest.
    const ok = await patch(U.manager, { mailbox_id: target, priority: before.priority === "urgent" ? "low" : "urgent" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.changed, ["priority", "mailbox_id"]);
    assert.equal(ok.body.ticket.mailbox_id, target, "the reply carries the ticket as it is now");
    assert.equal((await trail())[1], trailBefore[1] + 1);
  });

  test("the queue row and the reads carry the address; a merge keeps the kept ticket's", async () => {
    await pool().query("UPDATE hd_tickets SET mailbox_id = $2 WHERE id = $1", [t.id, box.c.id]);
    const full = (await tickets.getTicketById(t.id))!;
    assert.deepEqual([full.mailbox_id, full.mailbox_address, full.mailbox_name], [box.c.id, C, "Acme Press"]);
    const row = tickets.listRow(full);
    assert.deepEqual([row.mailbox_id, row.mailbox_address], [box.c.id, C]);
    const other = await tickets.createTicket(
      { subject: `${STAMP} dup`, body: "same", requester: { id: null, name: "Cara Customer", email: `${STAMP}-cara2@customer.example.test` }, team_id: teamB, mailbox_id: box.a.id, via: "email", source: "email" } as never,
      { silent: true }
    );
    ticketIds.push(other.id);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
    const r = await merge.mergeTickets({ id: U.manager.id, name: U.manager.name, role: "viewer" }, { keep: t.number, merge: [other.number], notify: false });
    assert.deepEqual(r.merged.map((m) => m.number), [other.number]);
    assert.equal((await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].mailbox_id, box.c.id, "the kept ticket's address stays");
  });

  test("API v1 and webhooks: the additive `mailbox` field", async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const api = require("../src/lib/helpdesk/api-v1") as typeof import("../src/lib/helpdesk/api-v1");
    const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const user = { id: U.manager.id, name: U.manager.name, username: U.manager.name, role: "viewer" };
    const ctx = { req: new Request("http://localhost/api/v1/helpdesk/tickets"), p: { user }, user, origin: "http://localhost" } as never;
    const one = await api.getTicketRoute(ctx, String(t.number));
    assert.equal(one.status, 200);
    assert.deepEqual((one.body as { mailbox: unknown }).mailbox, { id: box.c.id, address: C, name: "Acme Press" });
    // A ticket with no address of its own: null (the desk works it out when it sends).
    const plain = await tickets.createTicket({ subject: `${STAMP} plain`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, team_id: teamB } as never, { silent: true });
    ticketIds.push(plain.id);
    assert.equal(((await api.getTicketRoute(ctx, String(plain.number))).body as { mailbox: unknown }).mailbox, null);

    hooks.setWebhookAutoSendForTests(false);
    const { hook } = await hooks.createWebhook(
      { name: `${STAMP} hook`, url: "https://hooks.example.test/in", events: ["ticket.updated"], team_ids: [teamB], include_notes: false },
      { id: U.manager.id, name: U.manager.name, role: "viewer" }
    );
    try {
      assert.equal(await hooks.emitHelpdeskWebhookEvent("ticket.updated", { ticketId: t.id, changed: ["mailbox_id"] }), 1);
      assert.equal(await hooks.emitHelpdeskWebhookEvent("ticket.updated", { ticketId: plain.id, changed: ["priority"] }), 1);
      const rows = (await pool().query("SELECT ticket_id, payload FROM hd_webhook_deliveries WHERE hook_id = $1 ORDER BY id", [hook.id])).rows;
      assert.deepEqual(rows.map((r) => r.payload.ticket.mailbox), [{ id: box.c.id, address: C, name: "Acme Press" }, null]);
    } finally {
      await pool().query("DELETE FROM hd_webhook_deliveries WHERE hook_id = $1", [hook.id]);
      await pool().query("DELETE FROM hd_webhooks WHERE id = $1", [hook.id]);
      hooks.setWebhookAutoSendForTests(true);
    }
  });
});

// --- 1.20.5: send-from addresses ------------------------------------------------------------

describe("send-from addresses (1.20.5)", () => {
  const SBASE = "http://localhost/api/helpdesk/admin/send-addresses";
  const N = `no-reply@${DOMAIN}`;
  const S = `support@${DOMAIN}`;
  const WORKSPACE = "The workspace address";
  type Sender = { id: number; address: string; name: string; last_error: string; used_by: { id: number; address: string }[] };
  const rawBox = async (id: number) => (await pool().query("SELECT send_from, send_from_error, send_address_id FROM hd_mailboxes WHERE id = $1", [id])).rows[0];
  const senders = async (): Promise<Sender[]> => (await pool().query("SELECT id, address, name, last_error FROM hd_send_addresses ORDER BY lower(address)")).rows;
  const post = (b: unknown, who: Person | null = U.manager) => call(sendersRoute.POST, req(SBASE, who, b));
  const patch = (id: number, b: unknown, who: Person | null = U.manager) => call(senderRoute.PATCH, req(`${SBASE}/${id}`, who, b, "PATCH"), { id: String(id) });
  const del = (id: number, who: Person | null = U.manager) => call(senderRoute.DELETE, req(`${SBASE}/${id}`, who, undefined, "DELETE"), { id: String(id) });
  const sendTest = (id: number, who: Person | null = U.manager) => call(senderTestRoute.POST, req(`${SBASE}/${id}/test`, who), { id: String(id) });
  const list = async (): Promise<Sender[]> => (await call(sendersRoute.GET, req(SBASE, U.manager, undefined, "GET"))).body.send_addresses;
  const patchBox = (id: number, b: unknown) => call(oneRoute.PATCH, req(`${BASE}/${id}`, U.manager, b, "PATCH"), { id: String(id) });
  const refusals = async (id: number) => (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.send_address.refused' AND target_id = $1 ORDER BY id", [String(id)])).rows;
  const vars = { ticket_number: "1", subject: "x", requester_name: "Cara", team_name: "T", priority_label: "Normal", agent_name: "Ana", ticket_url: "/help/requests/1", message: "Hello", reply_excerpt: "Hello" };
  async function ticketOn(mailboxId: number, teamId: number) {
    const t = await tickets.createTicket(
      { subject: `${STAMP} send-from`, body: "x", requester: { id: null, name: "Cara Customer", email: `${STAMP}-cara5@customer.example.test` }, team_id: teamId, mailbox_id: mailboxId, via: "email", source: "email" } as never,
      { silent: true }
    );
    ticketIds.push(t.id);
    return t;
  }
  async function send(t: { id: number; number: number; team_id: number | null }) {
    mail.length = 0;
    const ok = await email.sendHelpdeskTemplate(`${STAMP}-cara5@customer.example.test`, "hd_reply", { ...vars, ticket_number: String(t.number) }, { ticketId: t.id, number: t.number, teamId: t.team_id });
    return { ok, m: mail[mail.length - 1], all: [...mail] };
  }

  /** No help address, no send-from address, and no old setting to seed one from. */
  async function fresh() {
    await wipeMailboxes();
    await settingsLib.saveHelpdeskSettings({ inbound_address: "" }, { syncMailboxes: false });
  }

  before(() => {
    refuseFrom.clear();
    failNext = null;
  });

  test("upgrade: a help address that sent from itself gets a send-from address equal to it, once; the old column stays true", async () => {
    await fresh();
    // The rows as 1.20.4 left them: A sends from itself and was refused yesterday, B does not, C does.
    const made = await pool().query(
      `INSERT INTO hd_mailboxes (address, name, send_from, send_from_error, send_from_error_at, is_default, position) VALUES
         ($1, 'Acme Help', true, '553 5.7.1 Sender address rejected', now() - interval '1 day', true, 0),
         ($2, 'Acme Billing', false, '', NULL, false, 1),
         ($3, 'Acme Press', true, '', NULL, false, 2) RETURNING id`,
      [A, B, C]
    );
    const [ia, ib, ic] = made.rows.map((r) => r.id as number);
    assert.equal((await senders()).length, 0);
    mailboxes.resetMailboxesReadyForTests();
    let boxes = await mailboxes.listMailboxes();
    assert.deepEqual(boxes.map((m) => [m.address, m.send_from, m.send_address, m.send_address_name]), [[A, true, A, ""], [B, false, null, null], [C, true, C, ""]]);
    assert.deepEqual((await senders()).map((s) => [s.address, s.name, s.last_error]), [[A, "", "553 5.7.1 Sender address rejected"], [C, "", ""]], "no name of its own, and the refusal 1.20.4 recorded comes along");
    assert.match(boxes[0].send_from_error, /^553/);
    assert.ok(boxes[0].send_from_error_at);
    // Nothing a requester sees changes: the same From, the same name, the same Reply-To.
    const who = await mailboxes.outboundIdentity((await ticketOn(ia, teamA)).id);
    assert.deepEqual([who.name, who.address, who.sendFrom, who.fromAddress], ["Acme Help", A, true, A]);
    assert.deepEqual(await mailboxes.outboundIdentity((await ticketOn(ib, teamB)).id), { mailboxId: ib, name: "Acme Billing", address: B, sendFrom: false });
    // A second start, and a second process: nothing more.
    mailboxes.resetMailboxesReadyForTests();
    await mailboxes.listMailboxes();
    sendAddresses.resetSendAddressesReadyForTests();
    await sendAddresses.sendAddressesReady();
    assert.deepEqual((await senders()).map((s) => s.address), [A, C]);
    // The 1.20.2 columns still say what a 1.20.4 binary reads.
    assert.deepEqual([(await rawBox(ia)).send_from, (await rawBox(ib)).send_from, (await rawBox(ic)).send_from], [true, false, true]);
    assert.match((await rawBox(ia)).send_from_error, /^553/);

    // A 1.20.4 binary on the same database flips the switch: the next start takes it over.
    await pool().query("UPDATE hd_mailboxes SET send_from = true WHERE id = $1", [ib]);
    await pool().query("UPDATE hd_mailboxes SET send_from = false WHERE id = $1", [ic]);
    mailboxes.resetMailboxesReadyForTests();
    boxes = await mailboxes.listMailboxes();
    assert.deepEqual(boxes.map((m) => [m.address, m.send_from, m.send_address]), [[A, true, A], [B, true, B], [C, false, null]]);
    assert.deepEqual((await senders()).map((s) => s.address), [B, A, C], "C stays on the list for another help address to pick");
    // And without a restart: a write here adopts it first, so the mirror does not undo it.
    await pool().query("UPDATE hd_mailboxes SET send_from = false WHERE id = $1", [ib]);
    await mailboxes.updateMailbox(ia, { name: "Acme Helpdesk" }, by());
    assert.deepEqual([(await rawBox(ib)).send_from, (await rawBox(ib)).send_address_id], [false, null]);
    assert.equal((await rawBox(ia)).send_from, true);
  });

  test("the list: permissions, the address rules, duplicates, edits and the cap", async () => {
    await fresh();
    for (const who of [null, U.req, U.agent, U.newbie]) {
      const expected = who === null ? 401 : 403;
      assert.equal((await call(sendersRoute.GET, req(SBASE, who, undefined, "GET"))).status, expected, `GET as ${who?.name}`);
      assert.equal((await post({ address: N }, who)).status, expected);
      assert.equal((await patch(1, { name: "x" }, who)).status, expected);
      assert.equal((await del(1, who)).status, expected);
      assert.equal((await sendTest(1, who)).status, expected);
    }
    assert.equal((await senders()).length, 0, "nothing was written");
    assert.equal((await post({ address: "nope" })).body.error, "That is not an email address.");
    assert.match((await post({ address: `no-reply+x@${DOMAIN}` })).body.error, /\+ tag/);
    assert.match((await post({})).body.error, /Enter the address to send from/);
    assert.match((await post({ address: `Acme <${N}>` })).body.error, /not an email address/);
    assert.match((await post({ address: `${N}\r\nBcc: x@evil.example` })).body.error, /not an email address/);
    assert.match((await post({ address: N, name: 5 })).body.error, /name is text/);
    assert.match((await post({ address: N, name: "x".repeat(81) })).body.error, /under 80 characters/);
    assert.match((await post({ address: `${"a".repeat(200)}@${DOMAIN}` })).body.error, /under 200 characters/);
    const n = await post({ address: ` No-Reply@${DOMAIN.toUpperCase()} `, name: ' Acme "Support" <x>\r\nBcc: y ' });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    assert.deepEqual([n.body.send_address.address, n.body.send_address.name], [N, "Acme Support x Bcc: y"], "stored clean: no quotes, brackets or line breaks");
    assert.equal((await post({ address: N.toUpperCase() })).status, 409);
    const s = await post({ address: S });
    assert.equal(s.body.send_address.name, "", "the name is optional");
    assert.deepEqual((await list()).map((x) => [x.address, x.name, x.used_by]), [[N, "Acme Support x Bcc: y", []], [S, "", []]]);
    const page = await call(listRoute.GET, req(BASE, U.manager, undefined, "GET"));
    assert.deepEqual([page.body.send_addresses.length, page.body.send_address_limit], [2, 200], "the Email page reads both lists in one answer");
    // Edit.
    assert.equal((await patch(s.body.send_address.id, { address: N })).status, 409);
    assert.equal((await patch(999999, { name: "x" })).status, 404);
    const e = await patch(n.body.send_address.id, { name: "" });
    assert.deepEqual([e.status, e.body.send_address.name], [200, ""]);
    const audit = (await pool().query("SELECT action, details FROM audit_log WHERE target_type = 'helpdesk_send_address' AND target_id = $1 ORDER BY id", [String(n.body.send_address.id)])).rows;
    assert.deepEqual(audit.map((r) => r.action), ["helpdesk.send_address.created", "helpdesk.send_address.updated"]);
    assert.deepEqual(audit[0].details, { address: N, name: "Acme Support x Bcc: y" });
    assert.deepEqual(audit[1].details.changes, { name: { from: "Acme Support x Bcc: y", to: "None (the help address's name)" } });
    // The cap: 200 on the list, said plainly.
    assert.equal(shared.SEND_ADDRESS_LIMITS.addresses, 200);
    await pool().query("INSERT INTO hd_send_addresses (address) SELECT 'cap' || g || '@' || $1 FROM generate_series(1, 198) g", [DOMAIN]);
    const over = await post({ address: `one-more@${DOMAIN}` });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /Up to 200 send-from addresses/);
    // The old `send_from: true` write (and the upgrade) is not held to it.
    const box = await mailboxes.createMailbox({ address: A, name: "Acme Help", send_from: true }, by());
    assert.deepEqual([box.send_address, box.send_from], [A, true]);
    assert.equal((await senders()).length, 201);
    await pool().query("DELETE FROM hd_send_addresses WHERE address LIKE 'cap%'");
  });

  test("the pick on a help address: by id, the old send_from write, and the mirrored column", async () => {
    await fresh();
    const a = await mailboxes.createMailbox({ address: A, name: "Acme Help" }, by());
    const n = (await post({ address: N, name: "Acme Support" })).body.send_address as Sender;
    assert.deepEqual([a.send_address_id, a.send_address, a.send_from], [null, null, false]);
    let r = await patchBox(a.id, { send_address_id: n.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.mailbox.send_address_id, r.body.mailbox.send_address, r.body.mailbox.send_address_name, r.body.mailbox.send_from], [n.id, N, "Acme Support", false]);
    assert.equal((await rawBox(a.id)).send_from, false, "another address than its own: the old column stays off");
    const row = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.mailbox.updated' AND target_id = $1 ORDER BY id DESC LIMIT 1", [String(a.id)])).rows[0];
    assert.deepEqual(row.details.changes, { send_address: { from: WORKSPACE, to: N } });
    assert.match((await patchBox(a.id, { send_address_id: 999999999 })).body.error, /no longer on the list/);
    assert.match((await patchBox(a.id, { send_address_id: "x" })).body.error, /send_address_id must be/);
    assert.equal((await mailboxes.getMailbox(a.id))!.send_address, N, "a refused write changes nothing");

    // The old write. true: its own address, added to the list when missing.
    r = await patchBox(a.id, { send_from: true });
    assert.deepEqual([r.body.mailbox.send_address, r.body.mailbox.send_from, r.body.mailbox.send_address_name], [A, true, ""]);
    assert.equal((await rawBox(a.id)).send_from, true);
    assert.deepEqual((await senders()).map((s) => s.address), [A, N]);
    await patchBox(a.id, { send_from: true });
    assert.equal((await senders()).length, 2, "sent again: nothing new");
    // false: the workspace address. The send-from address stays on the list.
    r = await patchBox(a.id, { send_from: false });
    assert.deepEqual([r.body.mailbox.send_address_id, r.body.mailbox.send_from, (await rawBox(a.id)).send_from], [null, false, false]);
    assert.equal((await senders()).length, 2);
    // Both in one write: the id wins.
    r = await patchBox(a.id, { send_from: true, send_address_id: n.id });
    assert.deepEqual([r.body.mailbox.send_address, r.body.mailbox.send_from], [N, false]);
    r = await patchBox(a.id, { send_from: true, send_address_id: null });
    assert.deepEqual([r.body.mailbox.send_address, r.body.mailbox.send_from], [null, false]);
    assert.match((await patchBox(a.id, { send_from: "yes" })).body.error, /send_from is true or false/);

    // A new help address with a pick; the list names who uses what; the agents' short list says where replies go from.
    const b = await call(listRoute.POST, req(BASE, U.manager, { address: B, name: "Acme Billing", send_address_id: n.id }));
    assert.deepEqual([b.status, b.body.mailbox.send_address], [201, N]);
    await patchBox(a.id, { send_address_id: n.id });
    assert.deepEqual((await list()).map((x) => [x.address, x.used_by]), [[A, []], [N, [{ id: a.id, address: A }, { id: b.body.mailbox.id, address: B }]]]);
    const short = (await call(agentRoute.GET, req("http://localhost/api/helpdesk/mailboxes", U.manager, undefined, "GET"))).body.mailboxes;
    assert.deepEqual(short.map((m: { address: string; send_from: boolean; send_address: string | null }) => [m.address, m.send_from, m.send_address]), [[A, false, N], [B, false, N]]);

    // A help address that sends from itself still does when its address changes (as its switch did before)…
    await patchBox(a.id, { send_from: true });
    r = await patchBox(a.id, { address: `helpdesk@${DOMAIN}` });
    assert.deepEqual([r.body.mailbox.send_address, r.body.mailbox.send_from, (await rawBox(a.id)).send_from], [`helpdesk@${DOMAIN}`, true, true]);
    // …unless the same write picks one.
    r = await patchBox(a.id, { address: A, send_address_id: n.id });
    assert.deepEqual([r.body.mailbox.address, r.body.mailbox.send_address, r.body.mailbox.send_from], [A, N, false]);
    // The old settings API moving the default's address: the same.
    await patchBox(a.id, { send_from: true });
    await settingsLib.saveHelpdeskSettings({ inbound_address: `frontdesk@${DOMAIN}` });
    let now = (await mailboxes.getMailbox(a.id))!;
    assert.deepEqual([now.address, now.send_address, now.send_from, (await rawBox(a.id)).send_from], [`frontdesk@${DOMAIN}`, `frontdesk@${DOMAIN}`, true, true]);
    await mailboxes.updateMailbox(a.id, { address: A, send_address_id: n.id }, by());
    // A send-from address edited to be a help address's own: the old column follows, and the refusal held against the old address is dropped.
    await sendAddresses.recordSendAddressFailure(n.id, "553 refused");
    const moved = await patch(n.id, { address: B });
    assert.deepEqual([moved.status, moved.body.send_address.address, moved.body.send_address.last_error], [200, B, ""]);
    now = (await mailboxes.getMailbox(b.body.mailbox.id))!;
    assert.deepEqual([now.send_address, now.send_from, (await rawBox(now.id)).send_from, (await rawBox(a.id)).send_from], [B, true, true, false]);
    await pool().query("DELETE FROM audit_log WHERE action = 'helpdesk.send_address.refused' AND target_id = $1", [String(n.id)]);
  });

  test("outbound: From the picked address, under its name when it has one; Reply-To stays the help address; a refusal falls back and is audited once", async () => {
    await fresh();
    mail.length = 0;
    await email.sendHelpdeskTemplate(`${STAMP}-probe@customer.example.test`, "hd_portal_link", { portal_name: "x", signin_url: "https://x.test/", minutes: "15", org_name: "x" }, null);
    const transportFrom = bare(mail[0].from);
    const n = (await post({ address: N, name: "Acme Support" })).body.send_address as Sender;
    const s = (await post({ address: S })).body.send_address as Sender;
    const a = await mailboxes.createMailbox({ address: A, name: "Acme Help", team_id: teamA, send_address_id: n.id }, by());
    const b = await mailboxes.createMailbox({ address: B, name: "Acme Billing", team_id: teamB, send_address_id: s.id }, by());
    const ta = await ticketOn(a.id, teamA);
    const tb = await ticketOn(b.id, teamB);
    const first = await send(ta);
    assert.equal(first.m.from, `"Acme Support" <${N}>`, "the send-from address's own name");
    assert.equal(first.m.replyTo, `help+hd-${(await email.ensureReplyToken(ta.id))!}@${DOMAIN}`, "answers come back to the help address");
    const second = await send(tb);
    assert.equal(second.m.from, `"Acme Billing" <${S}>`, "no name of its own: the help address's name");
    assert.match(second.m.replyTo!, /^billing\+hd-/);
    // Agent-only notices: the workspace address under the default help address's name, as before.
    mail.length = 0;
    assert.equal(await email.sendHelpdeskEmail(U.agent.id, "hd_assigned", { ticket_number: String(tb.number) }), true);
    assert.equal(mail[mail.length - 1].from, `"Acme Help" <${transportFrom}>`);

    // The provider refuses no-reply@: the same mail from the workspace address, under the same name.
    refuseFrom.add(N);
    attempts = 0;
    const fell = await send(ta);
    assert.deepEqual([fell.ok, fell.all.length, attempts], [true, 1, 2]);
    assert.equal(fell.m.from, `"Acme Support" <${transportFrom}>`);
    assert.match(fell.m.replyTo!, /^help\+hd-/);
    let stored = (await sendAddresses.getSendAddress(n.id))!;
    assert.match(stored.last_error, /553 5\.7\.1 Sender address rejected/);
    assert.ok(stored.last_error_at);
    assert.match((await mailboxes.getMailbox(a.id))!.send_from_error, /Sender address rejected/, "the help address reads its pick's refusal");
    assert.equal((await mailboxes.getMailbox(a.id))!.send_address_id, n.id, "the pick is the admin's: it is not undone");
    assert.equal((await rawBox(a.id)).send_from_error, "", "not its own address: the old column holds nothing");
    // A second help address on the same send-from address, and more mail: still one audit row for the streak.
    await patchBox(b.id, { send_address_id: n.id });
    await send(tb);
    await send(ta);
    const logged = await refusals(n.id);
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0].details, { address: N, error: "553 5.7.1 Sender address rejected: not owned by user smtp@example.test", sent_from: "workspace address", help_address: A });
    assert.deepEqual((await list()).find((x) => x.id === n.id)!.used_by.map((m) => m.address), [A, B]);
    // Accepted again: cleared, and a later refusal is a new streak.
    refuseFrom.clear();
    assert.equal((await send(tb)).m.from, `"Acme Support" <${N}>`);
    stored = (await sendAddresses.getSendAddress(n.id))!;
    assert.deepEqual([stored.last_error, stored.last_error_at], ["", null]);
    refuseFrom.add(N);
    await send(ta);
    assert.equal((await refusals(n.id)).length, 2);
    // A timeout says nothing about the address: no second send, nothing recorded.
    await sendAddresses.clearSendAddressFailure(n.id);
    refuseFrom.clear();
    attempts = 0;
    failNext = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" });
    const timeout = await send(ta);
    assert.deepEqual([timeout.ok, attempts, (await sendAddresses.getSendAddress(n.id))!.last_error], [false, 1, ""]);
    // A send-from address equal to the workspace's own: one send, nothing to fall back to.
    const w = (await post({ address: transportFrom })).body.send_address as Sender;
    await patchBox(a.id, { send_address_id: w.id });
    attempts = 0;
    assert.equal((await send(ta)).m.from, `"Acme Help" <${transportFrom}>`);
    assert.equal(attempts, 1);
    await patchBox(a.id, { send_address_id: n.id });
    await del(w.id);

    // The help address's own Send test leaves as a reply would. (Not through its route: the
    // earlier tests used this person's five a minute.)
    mail.length = 0;
    assert.deepEqual(await email.sendMailboxTestMail((await mailboxes.getMailbox(a.id))!, U.manager.email), { ok: true, from: N });
    assert.deepEqual([mail[0].from, mail[0].replyTo, mail[0].subject], [`"Acme Support" <${N}>`, A, `Test from ${A}`]);
  });

  test("Send test on a send-from address: to the admin's own address, From it, and the provider's refusal is kept", async () => {
    const [n, s] = [(await senders()).find((x) => x.address === N)!, (await senders()).find((x) => x.address === S)!];
    const [a, b] = await mailboxes.listMailboxes();
    await patchBox(b.id, { send_address_id: s.id });
    mail.length = 0;
    const ok = await sendTest(n.id);
    assert.deepEqual(ok.body, { ok: true, to: U.manager.email, from: N });
    assert.deepEqual([mail[0].to, mail[0].from, mail[0].replyTo, mail[0].subject], [U.manager.email, `"Acme Support" <${N}>`, undefined, `Test from ${N}`]);
    assert.equal(mail[0].headers["X-CompassDocs-Helpdesk"], "1", "a test that comes back in is dropped as our own");
    // No name of its own: the name of the help address that sends from it.
    await sendTest(s.id);
    assert.equal(mail[1].from, `"Acme Billing" <${S}>`);
    refuseFrom.add(N);
    mail.length = 0;
    const before = (await refusals(n.id)).length;
    const refused = await sendTest(n.id);
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.body, { ok: false, to: U.manager.email, from: N, error: "553 5.7.1 Sender address rejected: not owned by user smtp@example.test" });
    assert.equal(mail.length, 0, "no fallback on a test: the refusal is the answer");
    assert.match((await list()).find((x) => x.id === n.id)!.last_error, /Sender address rejected/);
    assert.match((await mailboxes.getMailbox(a.id))!.send_from_error, /Sender address rejected/);
    assert.equal((await refusals(n.id)).length, before + 1);
    assert.equal((await refusals(n.id)).at(-1)!.details.help_address, undefined, "a test of the address alone names no help address");
    refuseFrom.clear();
    assert.equal((await sendTest(n.id)).body.ok, true);
    assert.equal((await sendAddresses.getSendAddress(n.id))!.last_error, "", "a test that goes through clears the warning");
    assert.equal((await sendTest(999999)).status, 404);
    const tested = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.send_address.tested' AND target_id = $1 ORDER BY id", [String(n.id)])).rows;
    assert.deepEqual(tested.map((r) => r.details.result), ["sent", "refused", "sent"]);
  });

  test("removing a send-from address in use: its help addresses go back to the workspace address", async () => {
    const n = (await senders()).find((x) => x.address === N)!;
    const [a, b] = await mailboxes.listMailboxes();
    await patchBox(b.id, { send_address_id: n.id });
    const gone = await del(n.id);
    assert.deepEqual(gone.body, { ok: true, released: [{ id: a.id, address: A }, { id: b.id, address: B }] });
    assert.deepEqual((await mailboxes.listMailboxes()).map((m) => [m.address, m.send_address_id, m.send_address, m.send_from, m.send_from_error]), [[A, null, null, false, ""], [B, null, null, false, ""]]);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.send_address.deleted' AND target_id = $1", [String(n.id)])).rows[0];
    assert.deepEqual(audit.details, { address: N, help_addresses: [A, B], they_now_send_from: WORKSPACE });
    assert.equal((await del(n.id)).status, 404);
    // Mail keeps going, from the workspace address under the help address's name.
    const out = await send(await ticketOn(a.id, teamA));
    assert.equal(out.ok, true);
    assert.match(out.m.from, /^"Acme Help" </);
    assert.match(out.m.replyTo!, /^help\+hd-/);
    // One that nothing uses just goes.
    const s = (await senders()).find((x) => x.address === S)!;
    assert.deepEqual((await del(s.id)).body, { ok: true, released: [] });
    // A help address's own address removed from the list: the old column goes off with it, so the next start does not add it back.
    await patchBox(a.id, { send_from: true });
    const own = (await senders()).find((x) => x.address === A)!;
    assert.deepEqual((await del(own.id)).body.released, [{ id: a.id, address: A }]);
    assert.equal((await rawBox(a.id)).send_from, false);
    mailboxes.resetMailboxesReadyForTests();
    assert.equal((await mailboxes.getMailbox(a.id))!.send_address, null);
    assert.deepEqual(await senders(), []);
    // Removing a help address leaves its send-from address on the list.
    await patchBox(b.id, { send_from: true });
    await mailboxes.deleteMailbox(b.id, by());
    assert.deepEqual((await list()).map((x) => [x.address, x.used_by]), [[B, []]]);
  });
});

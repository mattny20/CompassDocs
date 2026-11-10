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
//     test send, and the additive `mailbox` field of the API and webhooks.
//
// hd_mailboxes is workspace-wide: the whole file runs under the email
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
const U: Record<"req" | "agent" | "newbie" | "manager", Person> = {} as never;
let teamA = 0;
let teamB = 0;
let teamAlias = 0;
const ALIAS = `${STAMP}-hr@example.test`;
const ticketIds: number[] = [];
const mail: HelpdeskOutgoingMail[] = [];
/** The transport refuses a From on these addresses (a provider that does not allow sending as them). */
const refuseFrom = new Set<string>();
let lockClient: PoolClient | null = null;
let savedBoxes: Record<string, unknown>[] = [];
let savedTickets: { id: number; mailbox_id: number }[] = [];
let savedSettings = { inbound_address: "", email_from_name: "", inbound_secret: "" };

const settle = () => new Promise((r) => setTimeout(r, 300));
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
  savedTickets = (await pool().query("SELECT id, mailbox_id FROM hd_tickets WHERE mailbox_id IS NOT NULL")).rows;
  const s = await settingsLib.getHelpdeskSettings();
  savedSettings = { inbound_address: s.inbound_address, email_from_name: s.email_from_name, inbound_secret: s.inbound_secret };
  await pool().query("DELETE FROM hd_mailboxes");
  await settingsLib.saveHelpdeskSettings({ inbound_address: "", email_from_name: "Helpdesk", inbound_secret: s.inbound_secret || settingsLib.newInboundSecret() }, { syncMailboxes: false });

  const names = { req: "Daniel Okafor", agent: "Ana Kowalski", newbie: "Noor Haddad", manager: "Mina Park" };
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
  for (const [k, role] of [["agent", "agent"], ["newbie", "newbie"], ["manager", "manager"]] as const) {
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
  email.setHelpdeskTransportForTests(async (m) => {
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
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teams]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_mailbox' AND target_label LIKE $1", [`%${DOMAIN}`]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  // The workspace's own mailboxes and settings, as found.
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
    // To two of ours: the first one in To wins, whichever copy (envelope recipient) arrives.
    const both = { to: "billing@acme.test, help@acme.test" };
    assert.equal(shared.mailboxForRecipients(boxes, g({ ...both, recipients: ["help@acme.test"] }))?.id, 2);
    assert.equal(shared.mailboxForRecipients(boxes, g({ ...both, recipients: ["billing@acme.test"] }))?.id, 2);
    // To beats Cc, Cc beats the envelope.
    assert.equal(shared.mailboxForRecipients(boxes, g({ to: "press@acme.test", cc: "billing@acme.test", recipients: ["help@acme.test"] }))?.id, 3);
    assert.deepEqual(shared.recipientCandidates(g({ to: "A@x.test", cc: "b@x.test, a@x.test", recipients: ["c@x.test"] })), ["a@x.test", "b@x.test", "c@x.test"]);
    assert.equal(shared.mailboxForRecipients([], g({ to: "help@acme.test" })), undefined);
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
    assert.deepEqual(audit[0].details, { address: B, name: "Acme Billing", team: `${STAMP} Billing`, send_from: true, is_default: false });
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
      send_from: { from: true, to: false },
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

  test("loops: our own addresses are never a requester", async () => {
    for (const from of [A, B.toUpperCase(), `press+anything@${DOMAIN}`, `whatever+hd-k7q2xz9m4pqa1b2c@elsewhere.example.test`]) {
      const before = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE lower(requester_email) = lower($1)", [from])).rows[0].n;
      const r = await mailIn({ from: { email: from.toLowerCase(), name: "Acme" }, to: [{ email: B, name: "" }] });
      assert.equal(r.res.body.outcome, "ignored_loop", `${from}: ${JSON.stringify(r.res.body)}`);
      assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE lower(requester_email) = lower($1)", [from])).rows[0].n, before);
    }
    assert.equal(await mailboxes.isOwnAddress(`someone@${DOMAIN}`), false);
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
    const audits = async () => (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.mailbox.send_from_failed' AND target_id = $1 ORDER BY id", [String(box.b.id)])).rows;
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
    assert.deepEqual(logged[0].details, { address: B, error: "553 5.7.1 Sender address rejected: not owned by user smtp@example.test", sent_from: "workspace address" });
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
    await mailboxes.clearSendFromFailure(box.b.id);
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

  test("an agent changes Answer from: stored, a timeline line for agents, audited; refusals change nothing", async () => {
    assert.equal((await patch(U.newbie, { mailbox_id: box.c.id })).status, 403);
    assert.equal((await patch(U.agent, { mailbox_id: 999999999 })).status, 400);
    assert.equal((await patch(U.agent, { mailbox_id: "x" })).status, 400);
    assert.equal((await pool().query("SELECT mailbox_id FROM hd_tickets WHERE id = $1", [t.id])).rows[0].mailbox_id, null);
    const r = await patch(U.agent, { mailbox_id: box.c.id });
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
    assert.deepEqual((await patch(U.agent, { mailbox_id: box.c.id })).body.changed, []);
    const both = await patch(U.agent, { mailbox_id: box.a.id, priority: "high" });
    assert.deepEqual(both.body.changed.sort(), ["mailbox_id", "priority"]);
    // Back to "work it out": the team's again.
    assert.deepEqual((await patch(U.agent, { mailbox_id: null })).body.changed, ["mailbox_id"]);
    assert.deepEqual((await get(U.agent)).body.mailbox, { id: box.b.id, address: B, name: "Acme Billing", own: false });
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

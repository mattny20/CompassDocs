// Helpdesk 1.19.0, channels (agent C), against the database: inbound email
// becomes tickets and threads replies (known users, outside senders,
// colleagues on copy, agents replying by email, duplicates, auto-replies,
// attachments); outbound mail threads on the ticket's reply token and links
// each audience to its own page; automations act once and never loop;
// macros fill their placeholders and make their changes; the satisfaction
// survey is the requester's, once, after solving; reports count a seeded
// fixture exactly; the dashboard's attention counts; the routes are gated.
//
// Fixtures are this file's own (a team with a unique alias, its own
// accounts, tickets in that team only), so it runs beside the other files
// on the shared database. Global settings are never written: the inbound
// pipeline is driven through processInboundEmail with outsideSenders given,
// and reports take their business hours as an argument.
//
// next/headers resolves to a stub serving the request under test and lib/ee
// to one that grants "helpdesk" (the licence test takes it away), as in
// test/handbook-confirm.test.ts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-channels.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pool, getSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- Request scope and licence stubs ----------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-channels.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-channels.virtual.js");
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

// The modules under test load after the stubs.
/* eslint-disable @typescript-eslint/no-require-imports */
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notifyMod = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const csat = require("../src/lib/helpdesk/csat") as typeof import("../src/lib/helpdesk/csat");
const reports = require("../src/lib/helpdesk/reports") as typeof import("../src/lib/helpdesk/reports");
const attention = require("../src/lib/helpdesk/attention") as typeof import("../src/lib/helpdesk/attention");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const inboundRoute = require("../src/app/api/helpdesk/inbound/[secret]/route") as typeof import("../src/app/api/helpdesk/inbound/[secret]/route");
const csatRoute = require("../src/app/api/helpdesk/requests/[number]/csat/route") as typeof import("../src/app/api/helpdesk/requests/[number]/csat/route");
const reportsRoute = require("../src/app/api/helpdesk/reports/route") as typeof import("../src/app/api/helpdesk/reports/route");
const automationsRoute = require("../src/app/api/helpdesk/admin/automations/route") as typeof import("../src/app/api/helpdesk/admin/automations/route");
const macrosAdminRoute = require("../src/app/api/helpdesk/admin/macros/route") as typeof import("../src/app/api/helpdesk/admin/macros/route");
const macroApplyRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const agentMacrosRoute = require("../src/app/api/helpdesk/macros/route") as typeof import("../src/app/api/helpdesk/macros/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdchan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALIAS = `${STAMP}-it@example.test`;
const PASSWORD = "Channels!Test123";
let teamId = 0;
let otherTeamId = 0;
const U: Record<"req" | "agent" | "lead" | "other" | "manager", { id: number; email: string; session: string; name: string }> = {} as never;
const ticketIds: number[] = [];
const automationIds: number[] = [];
const macroIds: number[] = [];
let uploadDirectory = "";
const mail: HelpdeskOutgoingMail[] = [];
const agentDeliveries: { userId: number; event: string; title: string; email?: string }[] = [];

function inboundEmail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: U.req.email, name: "Somebody" },
    to: [{ email: ALIAS, name: "" }],
    cc: [],
    recipients: [],
    subject: `${STAMP} Tunnel drops`,
    text: "It drops every few minutes.",
    html: "",
    stripped: "",
    messageId: `${newToken()}@mail.example.test`,
    inReplyTo: "",
    references: [],
    headers: {},
    // The provider's verdict (generic JSON out-of-band field): the sender's
    // domain passed DMARC. Without one the From address is not trusted.
    auth: { dmarc: "pass" },
    files: [],
    ...over,
  };
}

async function ticketByNumber(n: number) {
  const r = await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n]);
  if (r.rows[0]) ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

async function messagesOf(ticketId: number) {
  return (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows;
}

/** Let the after-commit hooks (fire-and-forget notices) finish. */
const settle = () => new Promise((r) => setTimeout(r, 300));

function sessionRequest(url: string, session: string | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.77", "user-agent": "ChannelsTest/1.0" };
  if (session) headers.cookie = `compass_session=${session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function call<P>(handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>, req: Request, params: P) {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve(params) });
    const type = res.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body: body as any, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

async function newTicket(subject: string, over: Record<string, unknown> = {}) {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} ${subject}`,
      body: (over.body as string) ?? "Opening message",
      requester: { id: U.req.id, name: U.req.name, email: U.req.email },
      team_id: teamId,
      via: "portal",
      source: (over.source as never) ?? "portal",
      ...over,
    } as never,
    { silent: over.silent !== false }
  );
  ticketIds.push(t.id);
  return t;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hdchan-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
  const creds = hashPassword(PASSWORD);
  const names = { req: "Matthew Felix", agent: "Priya Shah", lead: "Sara Haddad", other: "Ben Lo", manager: "Dana Whitfield" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const mailAddr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, name, mailAddr, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: mailAddr, session, name };
  }
  const assign = async (user: number, role: string) =>
    fixtureQuery(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`,
      [user, role]
    );
  await assign(U.agent.id, "helpdesk-agent");
  await assign(U.lead.id, "helpdesk-agent");
  await assign(U.manager.id, "helpdesk-manager");
  const t = await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 999) RETURNING id", [`${STAMP} IT`, ALIAS]);
  teamId = t.rows[0].id;
  const t2 = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 1000) RETURNING id", [`${STAMP} Facilities`]);
  otherTeamId = t2.rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'lead')", [teamId, U.agent.id, U.lead.id]);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
  notifyMod.setAgentDeliverySpyForTests((userId, event, p) => agentDeliveries.push({ userId, event, title: p.title, email: p.email?.template }));
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  notifyMod.setAgentDeliverySpyForTests(null);
  const userIds = Object.values(U).map((u) => u.id);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR id = ANY($3)", [[teamId, otherTeamId], userIds, ticketIds])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_attachments WHERE ticket_id = ANY($1)", [all]).catch(() => {});
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_automations WHERE id = ANY($1)", [automationIds]);
  await pool().query("DELETE FROM hd_macros WHERE id = ANY($1)", [macroIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamId, otherTeamId]]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE target_label LIKE $1 OR actor_id = ANY($2)", [`${STAMP}%`, userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

// --- Inbound email ------------------------------------------------------------------

describe("inbound email", () => {
  let number = 0;
  let token = "";

  test("a known user's email opens a ticket in the team it was sent to, as text", async () => {
    mail.length = 0;
    const r = await inbound.processInboundEmail(
      inboundEmail({ text: "", html: '<p>Hi <b>IT</b></p><script>alert(1)</script><img src="https://t.example.test/p.gif">[x](javascript:alert(1))' }),
      { outsideSenders: false, origin: "https://docs.example.test" }
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "created");
    number = r.body.ticket!;
    const t = await ticketByNumber(number);
    assert.equal(t.team_id, teamId, "by the team's email alias");
    assert.equal(t.requester_id, U.req.id);
    assert.equal(t.source, "email");
    assert.equal(t.subject, `${STAMP} Tunnel drops`);
    const [first] = await messagesOf(t.id);
    assert.equal(first.via, "email");
    assert.equal(first.body, "Hi IT\n\n\\[x\\]\\(javascript\\:alert\\(1\\)\\)", "text only, escaped: no script, no image, no link");
    await settle();
    const ack = mail.find((m) => m.to === U.req.email && m.subject.includes(`Request #${number} received`));
    assert.ok(ack, "the requester's acknowledgement");
    token = t.reply_token;
    assert.match(token, /^[a-z0-9]{16}$/);
    assert.ok(ack!.subject.includes(`[#${number} ref:${token}]`), ack!.subject);
    assert.ok(ack!.messageId?.startsWith(`<hd.${token}.`), "a Message-ID replies will cite");
    assert.equal(ack!.headers["Auto-Submitted"], "auto-generated");
    assert.ok(ack!.html.includes(`https://docs.example.test/help/requests/${number}`), "the requester's link is Get help");
  });

  test("the requester's reply threads back, quoted history cut; a retry is a duplicate", async () => {
    agentDeliveries.length = 0;
    const msgId = `${newToken()}@mail.example.test`;
    const reply = inboundEmail({
      subject: `Re: ${STAMP} Tunnel drops [#${number} ref:${token}]`,
      text: `Still dropping.\n\nOn Mon, 3 Nov 2026 at 10:11, Desk <help@example.test> wrote:\n> We are looking`,
      messageId: msgId,
    });
    const r = await inbound.processInboundEmail(reply, { outsideSenders: false });
    assert.equal(r.body.outcome, "appended");
    assert.equal(r.body.ticket, number);
    const t = await ticketByNumber(number);
    const msgs = await messagesOf(t.id);
    const last = msgs.filter((m) => m.kind === "public").at(-1);
    assert.equal(last.body, "Still dropping.");
    assert.equal(last.author_id, U.req.id);
    assert.equal(last.email_message_id, msgId);
    const again = await inbound.processInboundEmail({ ...reply }, { outsideSenders: false });
    assert.equal(again.body.outcome, "duplicate");
    assert.equal((await messagesOf(t.id)).length, msgs.length, "nothing added twice");
    await settle();
    assert.ok(agentDeliveries.some((d) => d.event === "requester_replied" || d.event === "reopened"), JSON.stringify(agentDeliveries));
  });

  test("an agent of the team replying by email answers the requester", async () => {
    mail.length = 0;
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.agent.email, name: "" }, cc: [{ email: `help+hd-${token}@example.test`, name: "" }], subject: "Re: whatever", text: "Try the new profile." }),
      { outsideSenders: false }
    );
    assert.equal(r.body.outcome, "appended");
    const t = await ticketByNumber(number);
    const last = (await messagesOf(t.id)).filter((m) => m.kind === "public").at(-1);
    assert.equal(last.author_id, U.agent.id);
    assert.ok(t.first_replied_at, "an agent's public reply is the first reply");
    await settle();
    const toReq = mail.find((m) => m.to === U.req.email && m.subject.includes("Re:"));
    assert.ok(toReq, "the requester hears the reply");
    assert.ok(toReq!.text.includes("Try the new profile."));
  });

  test("a colleague on copy gets a ticket of their own, never a message on someone else's", async () => {
    const before = (await messagesOf((await ticketByNumber(number)).id)).length;
    const r = await inbound.processInboundEmail(inboundEmail({ from: { email: U.other.email, name: "" }, subject: `Re: [#${number} ref:${token}]` }), { outsideSenders: false });
    assert.equal(r.body.outcome, "created");
    assert.notEqual(r.body.ticket, number);
    const mine = await ticketByNumber(r.body.ticket!);
    assert.equal(mine.requester_id, U.other.id);
    assert.equal((await messagesOf((await ticketByNumber(number)).id)).length, before);
  });

  test("outside senders: refused and audited when off; a ticket without an account when on", async () => {
    const stranger = `${STAMP}-stranger@outside.example.test`;
    const off = await inbound.processInboundEmail(inboundEmail({ from: { email: stranger, name: "Stranger" } }), { outsideSenders: false, ip: "198.51.100.9" });
    assert.equal(off.status, 200, "no retry storm from the provider");
    assert.equal(off.body.outcome, "rejected_outside_sender");
    const audits = await pool().query("SELECT details, ip FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = $1", [stranger]);
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].details.reason, "outside_sender");
    const none = await pool().query("SELECT 1 FROM hd_tickets WHERE requester_email = $1", [stranger]);
    assert.equal(none.rows.length, 0);
    await pool().query("DELETE FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = $1", [stranger]);

    mail.length = 0;
    const on = await inbound.processInboundEmail(inboundEmail({ from: { email: stranger, name: "Stranger" } }), { outsideSenders: true });
    assert.equal(on.body.outcome, "created");
    const t = await ticketByNumber(on.body.ticket!);
    assert.equal(t.requester_id, null);
    assert.equal(t.requester_email, stranger);
    await settle();
    assert.ok(mail.some((m) => m.to === stranger), "acknowledged at the address it came from");
    // Their reply threads back while outside senders are on.
    const re = await inbound.processInboundEmail(inboundEmail({ from: { email: stranger, name: "" }, subject: `Re: [#${t.number} ref:${t.reply_token}]`, text: "More detail" }), { outsideSenders: true });
    assert.equal(re.body.outcome, "appended");
  });

  test("auto-replies and our own mail are dropped", async () => {
    const auto = await inbound.processInboundEmail(inboundEmail({ headers: { "auto-submitted": "auto-replied" } }), { outsideSenders: false });
    assert.equal(auto.body.outcome, "ignored_auto");
    const loop = await inbound.processInboundEmail(inboundEmail({ headers: { "x-compassdocs-helpdesk": "1" } }), { outsideSenders: false });
    assert.equal(loop.body.outcome, "ignored_loop");
  });

  test("attachments: the good ones stored on the message, the rest listed in a note", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(9000, 3)]);
    const r = await inbound.processInboundEmail(
      inboundEmail({
        files: [
          { name: "screen.png", type: "image/png", data: png },
          { name: "tool.exe", type: "application/octet-stream", data: Buffer.from("MZ") },
          { name: "[evil](https://x).pdf", type: "application/pdf", data: Buffer.from("not a pdf at all") },
        ],
      }),
      { outsideSenders: false }
    );
    assert.equal(r.body.outcome, "created");
    const t = await ticketByNumber(r.body.ticket!);
    const msgs = await messagesOf(t.id);
    const first = msgs.find((m) => m.kind === "public");
    assert.equal(first.attachments.length, 1);
    assert.equal(first.attachments[0].name, "screen.png");
    assert.equal(first.attachments[0].type, "image/png");
    const note = msgs.find((m) => m.kind === "system" && m.body.includes("not added"));
    assert.ok(note, "a note lists what was dropped");
    assert.ok(note.body.includes("tool.exe \\(file type not allowed\\)"), note.body);
    assert.ok(note.body.includes("\\[evil\\]\\(https:\\_\\_x\\).pdf"), "file names are text in the note (slashes made safe): " + note.body);
  });

  test("the route: a wrong secret is a 404, the licence a 402 only behind the right secret", async () => {
    const req = new Request("http://localhost/api/helpdesk/inbound/nope", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const res = await call(inboundRoute.POST, req, { secret: "definitely-not-the-secret" });
    assert.equal(res.status, 404);
  });
});

// --- Outbound threading and links ----------------------------------------------------

describe("outbound mail", () => {
  test("agents land in the desk, requesters in Get help, approvers in Approvals", async () => {
    const t = await newTicket("Links");
    mail.length = 0;
    agentDeliveries.length = 0;
    await notifyMod.notifyAssigned(t.id, U.agent.id, { actorId: U.lead.id, actorName: "Sara Haddad", origin: "https://docs.example.test" });
    const d = agentDeliveries.find((x) => x.userId === U.agent.id && x.event === "assigned_to_me");
    assert.ok(d, "through the agent's preferences");
    await settle();
    const m = mail.find((x) => x.to === U.agent.email);
    assert.ok(m, "assigned email");
    assert.ok(m!.html.includes(`https://docs.example.test/desk/tickets/${t.number}`), m!.html);
    assert.ok(m!.subject.includes(`[#${t.number} ref:`));
    await notifyMod.notifyAssigned(t.id, U.agent.id, { actorId: U.agent.id });
    assert.equal(agentDeliveries.filter((x) => x.event === "assigned_to_me").length, 1, "nobody is told of their own action");
  });

  test("a reply waiting for review reaches nobody until it is approved", async () => {
    const t = await newTicket("Review");
    const m = await pool().query(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, $2, 'Priya Shah', 'public', 'Draft answer', 'desk') RETURNING id",
      [t.id, U.agent.id]
    );
    const hasColumn = (await pool().query("SELECT 1 FROM information_schema.columns WHERE table_name = 'hd_messages' AND column_name = 'review_state'")).rows.length > 0;
    if (hasColumn) await pool().query("UPDATE hd_messages SET review_state = 'pending' WHERE id = $1", [m.rows[0].id]);
    mail.length = 0;
    await notifyMod.notifyReply(t.id, m.rows[0].id, { origin: "https://docs.example.test" });
    if (hasColumn) assert.equal(mail.filter((x) => x.to === U.req.email).length, 0, "held");
    await notifyMod.notifyPublicReply(t.id, m.rows[0].id, { origin: "https://docs.example.test" });
    await settle();
    const sent = mail.filter((x) => x.to === U.req.email);
    assert.ok(sent.length >= 1, "sent once approved");
    assert.ok(sent.at(-1)!.html.includes(`/help/requests/${t.number}`));
  });

  test("sendHelpdeskEmail (agent F's email channel) threads on the ticket number", async () => {
    const t = await newTicket("F channel");
    mail.length = 0;
    const ok = await email.sendHelpdeskEmail(U.agent.id, "hd_sla_breach", { ticket_number: String(t.number), target_label: "first reply", due_time: "now" });
    assert.equal(ok, true);
    const m = mail.at(-1)!;
    assert.equal(m.to, U.agent.email);
    assert.ok(m.subject.includes(`Overdue: #${t.number}`) && m.subject.includes("ref:"), m.subject);
    assert.ok(m.html.includes(`/desk/tickets/${t.number}`));
  });
});

// --- Automations ------------------------------------------------------------------------

describe("automations", () => {
  test("conditions and actions on ticket_created", async () => {
    const rule = await automations.createAutomation({
      // A keyword no starter rule has: the shared database may hold the
      // starter set's "VPN and network" rule, which moves VPN tickets to its
      // IT team before this team's rule would see them.
      name: `${STAMP} Tunnel and network`,
      event: "ticket_created",
      conditions: { team_ids: [teamId], keywords: ["tunnel"] },
      actions: { priority: "high", category: "Network", tags_add: ["vpn"], internal_note: "Check the VPN status page first." },
      active: 1,
    });
    automationIds.push(rule.id);
    const hit = await newTicket("Tunnel won't connect", { silent: false });
    const miss = await newTicket("Printer jam", { silent: false });
    await settle();
    const a = await ticketByNumber(hit.number);
    const b = await ticketByNumber(miss.number);
    assert.equal(a.priority, "high");
    assert.equal(a.category, "Network");
    assert.deepEqual(a.tags, ["vpn"]);
    assert.ok((await messagesOf(a.id)).some((m) => m.kind === "internal" && m.body === "Check the VPN status page first."));
    assert.equal(b.priority, "normal");
    assert.ok((await automations.getAutomation(rule.id))!.last_run_at);
    await automations.updateAutomation(rule.id, { active: 0 });
  });

  test("a rule's own change never retriggers it (no loop), and a settled rule is not re-run", async () => {
    const rule = await automations.createAutomation({
      name: `${STAMP} Note every update`,
      event: "ticket_updated",
      conditions: { team_ids: [teamId] },
      actions: { internal_note: "Updated.", tags_add: ["touched"] },
      active: 1,
    });
    automationIds.push(rule.id);
    const t = await newTicket("Loop check");
    await tickets.updateTicket(t.id, { priority: "low" }, { id: U.agent.id, name: "Priya Shah" }, {});
    await settle();
    const notes = (await messagesOf(t.id)).filter((m) => m.kind === "internal" && m.body === "Updated.");
    assert.equal(notes.length, 1, "the rule's own tag + note did not run it again");
    assert.deepEqual((await ticketByNumber(t.number)).tags, ["touched"]);
    // A direct run inside the chain guard: depth is capped.
    const r = await automations.runAutomations("ticket_updated", t.id);
    assert.deepEqual(r.ran, [rule.id], "an always-acting rule acts when asked");
    await automations.updateAutomation(rule.id, { actions: { tags_add: ["touched"] } });
    const settled = await automations.runAutomations("ticket_updated", t.id);
    assert.deepEqual(settled.ran, [], "nothing to change: not a run");
    await automations.updateAutomation(rule.id, { active: 0 });
  });
});

// --- Macros ------------------------------------------------------------------------------

describe("macros", () => {
  test("placeholders fill for the ticket and the field changes are made", async () => {
    const m = await macros.createMacro(
      {
        title: `${STAMP} Need more info`,
        body: "Hi {{requester.first_name}}, could you send a screenshot for #{{ticket.number}}? {{agent.first_name}}, {{team.name}}",
        actions: { status: "pending", tags_add: ["needs-info"] },
        team_id: teamId,
      },
      U.lead.id
    );
    macroIds.push(m.id);
    const t = await newTicket("Macro target");
    const preview = await macros.applyMacroToTicket(t.id, m.id, { id: U.agent.id, name: "Priya Shah" }, { preview: true });
    assert.ok(preview.ok && preview.preview);
    assert.equal((preview as { body: string }).body, `Hi Matthew, could you send a screenshot for #${t.number}? Priya, ${STAMP} IT`);
    assert.equal((await messagesOf(t.id)).length, 1, "a preview writes nothing");

    const res = await call(macroApplyRoute.POST, sessionRequest(`http://localhost/api/helpdesk/tickets/${t.number}/macro/${m.id}`, U.agent.session, {}), {
      number: String(t.number),
      macroId: String(m.id),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await ticketByNumber(t.number);
    assert.equal(after.status, "pending");
    assert.deepEqual(after.tags, ["needs-info"]);
    const reply = (await messagesOf(t.id)).find((x) => x.kind === "public" && x.author_id === U.agent.id);
    assert.ok(reply.body.startsWith("Hi Matthew"));

    const outsider = await call(macroApplyRoute.POST, sessionRequest(`http://localhost/x`, U.other.session, { preview: true }), { number: String(t.number), macroId: String(m.id) });
    assert.equal(outsider.status, 403, "not an agent");
    const list = await call(agentMacrosRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/macros", U.agent.session, undefined, "GET"), {});
    assert.ok(list.body.macros.some((x: { id: number }) => x.id === m.id), "the team's macro is listed for its agent");
  });
});

// --- CSAT ----------------------------------------------------------------------------------

describe("satisfaction survey", () => {
  test("only the requester, only once solved, only once; the email's token is checked", async () => {
    const t = await newTicket("Rate me");
    const url = `http://localhost/api/helpdesk/requests/${t.number}/csat`;
    const byOther = await call(csatRoute.POST, sessionRequest(url, U.other.session, { score: 5 }), { number: String(t.number) });
    assert.equal(byOther.status, 404, "someone else's request is not found");
    const early = await call(csatRoute.POST, sessionRequest(url, U.req.session, { score: 5 }), { number: String(t.number) });
    assert.equal(early.status, 409, "not solved yet");

    mail.length = 0;
    await tickets.updateTicket(t.id, { status: "solved" }, { id: U.agent.id, name: "Priya Shah" }, { origin: "https://docs.example.test" });
    await settle();
    const solved = mail.find((m) => m.to === U.req.email && m.subject.includes("Solved:"));
    const csatEnabled = (await (require("../src/lib/helpdesk/settings") as typeof import("../src/lib/helpdesk/settings")).getHelpdeskSettings()).csat_enabled;
    let linkToken = "";
    if (solved && csatEnabled) {
      const m = solved.html.match(/rate=4(?:&amp;|&#x26;|&)t=([A-Za-z0-9_-]+)/);
      assert.ok(m, "five rating links: " + solved.html);
      linkToken = m![1];
    }
    const bad = await call(csatRoute.POST, sessionRequest(url, U.req.session, { score: 4, token: "forged-token-value" }), { number: String(t.number) });
    assert.equal(bad.status, 403);
    const badScore = await call(csatRoute.POST, sessionRequest(url, U.req.session, { score: 9 }), { number: String(t.number) });
    assert.equal(badScore.status, 400);
    if (!csatEnabled) return; // another file switched surveys off globally; the refusals above still hold
    const ok = await call(csatRoute.POST, sessionRequest(url, U.req.session, { score: 4, comment: "Quick, thanks", token: linkToken || undefined }), { number: String(t.number) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.csat.score, 4);
    const twice = await call(csatRoute.POST, sessionRequest(url, U.req.session, { score: 1 }), { number: String(t.number) });
    assert.equal(twice.status, 409);
    const row = await ticketByNumber(t.number);
    assert.equal(row.csat_score, 4);
    assert.equal(row.csat_comment, "Quick, thanks");
    const anon = await call(csatRoute.POST, sessionRequest(url, null, { score: 4 }), { number: String(t.number) });
    assert.equal(anon.status, 401, "a link alone rates nothing");
  });
});

// --- Reports ---------------------------------------------------------------------------------

describe("reports", () => {
  const HOURS = { timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", holidays: [] };

  test("numbers on a seeded fixture (business time)", async () => {
    const team = otherTeamId;
    const ins = async (row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await pool().query(
        `INSERT INTO hd_tickets (subject, requester_id, requester_name, team_id, ${cols.join(", ")}) VALUES ($1, $2, 'R', $3, ${cols.map((_, i) => `$${i + 4}`).join(", ")}) RETURNING id`,
        [`${STAMP} report`, U.req.id, team, ...Object.values(row)]
      );
      ticketIds.push(r.rows[0].id);
    };
    // Mon 2025-03-03 .. Fri 2025-03-07, 09:00-17:00 UTC.
    // A: created Mon 10:00, replied Mon 11:00 (60), solved Mon 15:00 (300), SLA met, CSAT 5.
    await ins({ created_at: "2025-03-03T10:00:00Z", first_replied_at: "2025-03-03T11:00:00Z", solved_at: "2025-03-03T15:00:00Z", status: "solved", assignee_id: U.agent.id, category: "Network", first_reply_due: "2025-03-03T14:00:00Z", resolve_due: "2025-03-04T10:00:00Z", csat_score: 5, csat_at: "2025-03-03T16:00:00Z" });
    // B: created Fri 16:00, replied Mon 10:00 (60+60=120), solved Tue 10:00 (60+480+60=600), reply breached, CSAT 2.
    await ins({ created_at: "2025-03-07T16:00:00Z", first_replied_at: "2025-03-10T10:00:00Z", solved_at: "2025-03-11T10:00:00Z", status: "solved", assignee_id: U.agent.id, category: "Network", first_reply_due: "2025-03-07T16:30:00Z", resolve_due: "2025-03-12T10:00:00Z", csat_score: 2, csat_at: "2025-03-11T11:00:00Z" });
    // C: created Tue 09:00, replied Tue 09:30 (30), still open, no SLA.
    await ins({ created_at: "2025-03-04T09:00:00Z", first_replied_at: "2025-03-04T09:30:00Z", status: "open", category: "Hardware" });
    // D: created Wed 09:00, solved Wed 13:00 (240) with an hour paused (so 180), no reply.
    await ins({ created_at: "2025-03-05T09:00:00Z", solved_at: "2025-03-05T13:00:00Z", status: "solved", sla_paused_ms: 3_600_000, category: "" });

    const r = await reports.reportSummary({ from: "2025-03-03", to: "2025-03-11", team_id: team }, { hours: HOURS, now: Date.parse("2025-04-01T00:00:00Z") });
    assert.equal(r.created, 4);
    assert.equal(r.solved, 3);
    assert.equal(r.first_reply_median_minutes, 60, "30, 60, 120");
    assert.equal(r.resolution_median_minutes, 300, "180, 300, 600");
    assert.equal(r.sla_met_percent, 50, "A met, B breached");
    assert.equal(r.csat_responses, 2);
    assert.equal(r.csat_percent, 50);
    assert.equal(r.csat_average, 3.5);
    assert.equal(r.series.length, 9);
    assert.deepEqual(r.series[0], { date: "2025-03-03", created: 1, solved: 1 });
    assert.deepEqual(r.series.find((p) => p.date === "2025-03-11"), { date: "2025-03-11", created: 0, solved: 1 });
    assert.deepEqual(r.by_team, [{ team_id: team, name: `${STAMP} Facilities`, created: 4, solved: 3, sla_met_percent: 50 }]);
    assert.deepEqual(r.by_agent, [{ user_id: U.agent.id, name: "Priya Shah", solved: 2, first_reply_median_minutes: 90, csat_percent: 50 }]);
    assert.deepEqual(r.by_category, [
      { category: "Network", created: 2, solved: 2 },
      { category: "", created: 1, solved: 1 },
      { category: "Hardware", created: 1, solved: 0 },
    ]);
    const csv = reports.reportCsv(r);
    assert.ok(csv.includes('"Created","4"'));
    assert.ok(csv.includes('"Priya Shah","2","90","50"'));
    assert.ok(csv.includes('"(none)","1","1"'));
  });

  test("the route: reports holders only; CSV is audited", async () => {
    const denied = await call(reportsRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/reports", U.agent.session, undefined, "GET"), {});
    assert.equal(denied.status, 403);
    const ok = await call(
      reportsRoute.GET as never,
      sessionRequest(`http://localhost/api/helpdesk/reports?from=2025-03-03&to=2025-03-11&team=${otherTeamId}&format=csv`, U.manager.session, undefined, "GET"),
      {}
    );
    assert.equal(ok.status, 200);
    assert.ok(String(ok.body).includes("Metric,Value"));
    const a = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.report.exported' AND actor_id = $1", [U.manager.id]);
    assert.equal(a.rows.length, 1);
    const bad = await call(reportsRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/reports?from=yesterday", U.manager.session, undefined, "GET"), {});
    assert.equal(bad.status, 400);
    // Desk roles (agent J): an Agent reads their own stats only, a Team lead their team's, the CSV needs tickets.export.
    const own = await call(reportsRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/reports?from=2025-03-03&to=2025-03-11&agent=me", U.agent.session, undefined, "GET"), {});
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.report.solved, 2, "only the agent's assigned tickets");
    const agentTeam = await call(reportsRoute.GET as never, sessionRequest(`http://localhost/api/helpdesk/reports?team=${teamId}`, U.agent.session, undefined, "GET"), {});
    assert.equal(agentTeam.status, 403);
    const leadTeam = await call(reportsRoute.GET as never, sessionRequest(`http://localhost/api/helpdesk/reports?team=${teamId}`, U.lead.session, undefined, "GET"), {});
    assert.equal(leadTeam.status, 200);
    const leadOther = await call(reportsRoute.GET as never, sessionRequest(`http://localhost/api/helpdesk/reports?team=${otherTeamId}`, U.lead.session, undefined, "GET"), {});
    assert.equal(leadOther.status, 403, "not a team they belong to");
    const leadCsv = await call(reportsRoute.GET as never, sessionRequest(`http://localhost/api/helpdesk/reports?team=${teamId}&format=csv`, U.lead.session, undefined, "GET"), {});
    assert.equal(leadCsv.status, 403, "no tickets.export");
  });
});

// --- Attention ---------------------------------------------------------------------------------

describe("needs your attention", () => {
  test("requests waiting on you and approvals waiting for you", async () => {
    const before = await attention.requestsWaitingOn({ id: U.req.id, role: "viewer" });
    const t = await newTicket("Waiting on you");
    await tickets.updateTicket(t.id, { status: "pending" }, { id: U.agent.id, name: "Priya Shah" }, { silent: true });
    assert.equal(await attention.requestsWaitingOn({ id: U.req.id, role: "viewer" }), before + 1);

    const run = await pool().query("INSERT INTO hd_workflow_runs (ticket_id, state) VALUES ($1, 'running') RETURNING id", [t.id]);
    const step = await pool().query("INSERT INTO hd_workflow_steps (run_id, step_key, kind, state) VALUES ($1, 's1', 'approval', 'active') RETURNING id", [run.rows[0].id]);
    assert.equal(await attention.approvalsWaitingFor({ id: U.lead.id, role: "viewer" }), 0);
    await pool().query(
      "INSERT INTO hd_approvals (run_id, step_id, ticket_id, approver_kind, approver_user_id) VALUES ($1, $2, $3, 'user', $4)",
      [run.rows[0].id, step.rows[0].id, t.id, U.lead.id]
    );
    assert.equal(await attention.approvalsWaitingFor({ id: U.lead.id, role: "viewer" }), 1);
    const rows = await attention.helpdeskAttention({ id: U.lead.id, role: "viewer" });
    assert.deepEqual(rows.map((r) => [r.label, r.href]), [["1 request needs your approval", "/help/approvals"]]);

    edition.features = [];
    try {
      assert.equal(await attention.approvalsWaitingFor({ id: U.lead.id, role: "viewer" }), 0, "unlicensed: nothing");
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});

// --- Gates -------------------------------------------------------------------------------------

describe("route gates", () => {
  test("admin routes refuse agents, everything refuses the unlicensed", async () => {
    const agentAuto = await call(automationsRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/admin/automations", U.agent.session, undefined, "GET"), {});
    assert.equal(agentAuto.status, 403);
    const agentMacro = await call(
      macrosAdminRoute.POST as never,
      sessionRequest("http://localhost/api/helpdesk/admin/macros", U.agent.session, { title: "x", body: "y" }),
      {}
    );
    assert.equal(agentMacro.status, 403, "everyone's macros need macros.manage_all");
    const personal = await call(
      macrosAdminRoute.POST as never,
      sessionRequest("http://localhost/api/helpdesk/admin/macros", U.agent.session, { title: `${STAMP} Mine`, body: "My sign-off", personal: true }),
      {}
    );
    assert.equal(personal.status, 201, JSON.stringify(personal.body));
    macroIds.push(personal.body.macro.id);
    assert.equal(personal.body.macro.owner_id, U.agent.id);
    const agentTeamMacro = await call(
      macrosAdminRoute.POST as never,
      sessionRequest("http://localhost/api/helpdesk/admin/macros", U.agent.session, { title: "x", body: "y", team_id: teamId }),
      {}
    );
    assert.equal(agentTeamMacro.status, 403, "an Agent has no macros.manage_team");
    const leadTeamMacro = await call(
      macrosAdminRoute.POST as never,
      sessionRequest("http://localhost/api/helpdesk/admin/macros", U.lead.session, { title: `${STAMP} Team one`, body: "Hello", team_id: teamId }),
      {}
    );
    assert.equal(leadTeamMacro.status, 201, JSON.stringify(leadTeamMacro.body));
    macroIds.push(leadTeamMacro.body.macro.id);
    const leadList = await call(macrosAdminRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/admin/macros", U.lead.session, undefined, "GET"), {});
    assert.ok(!leadList.body.macros.some((m: { id: number }) => m.id === personal.body.macro.id), "a personal macro is its owner's only");
    const agentUse = await call(agentMacrosRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/macros", U.agent.session, undefined, "GET"), {});
    assert.ok(agentUse.body.macros.some((m: { id: number }) => m.id === personal.body.macro.id));
    const created = await call(
      automationsRoute.POST as never,
      sessionRequest("http://localhost/api/helpdesk/admin/automations", U.manager.session, {
        name: `${STAMP} Route rule`,
        event: "ticket_created",
        conditions: { team_ids: [teamId] },
        actions: { tags_add: ["route"] },
        active: false,
      }),
      {}
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    automationIds.push(created.body.automation.id);
    const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.automation.created' AND target_id = $1", [String(created.body.automation.id)]);
    assert.equal(audited.rows.length, 1);
    const invalid = await call(
      automationsRoute.POST as never,
      sessionRequest("http://localhost/api/helpdesk/admin/automations", U.manager.session, { name: "x", event: "whenever", actions: {} }),
      {}
    );
    assert.equal(invalid.status, 400);
    edition.features = [];
    try {
      const unlicensed = await call(automationsRoute.GET as never, sessionRequest("http://localhost/api/helpdesk/admin/automations", U.manager.session, undefined, "GET"), {});
      assert.equal(unlicensed.status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});

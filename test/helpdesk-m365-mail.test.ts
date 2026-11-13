// Helpdesk 1.20.7: the Microsoft 365 mailbox connection (lib/helpdesk/m365),
// against a fake Microsoft on a loopback port (test/helpers/fake-m365).
// Nothing here contacts Microsoft.
//
//   - pure: Microsoft's sender verdict (pass, fail, none, a forged header,
//     internal mail, a planted "Internal"), a Graph message as an
//     InboundEmail (aliases, plus tags, typed recipients), the restrict
//     commands, the Graph-link guard, the notification address rule;
//   - the upgrade: an install with nothing configured (no Graph call, an idle
//     sweep, SMTP as it was);
//   - the connection: the manual form's refusals, the secret sealed, the
//     tenant guard; the one-click setup's refusals, rollback and the
//     not-yet-active save (when the enterprise overlay is present);
//   - mailboxes: unsupported kinds refused with what to use instead, a
//     mailbox waiting for access, the access check;
//   - intake: the delta read (what was there before is left alone, paging,
//     a lost delta link, a link to another host), the notification endpoint
//     (handshake, key, clientState, licence), exactly-once across
//     notification + timer + two workers, alias routing, every "who may add
//     to a ticket" rule through this path, attachments, mark read and move,
//     the retry cap;
//   - subscriptions: created, renewed, re-created, lifecycle events, a
//     refusal that falls back to the timer;
//   - sending through Graph and its fallback to SMTP;
//   - the routes' permissions.
//
// hd_mailboxes and the email settings are workspace-wide: the whole file
// runs under the email settings' advisory lock (728351, as
// test/helpdesk-mailboxes), and puts back what it changed.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-m365-mail.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { exchangeHeaders, failResults, passResults, startFakeM365, type FakeApp, type FakeM365, type FakeMessage } from "./helpers/fake-m365";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

// --- Request scope and licence stubs (as test/helpdesk-mailboxes.test.ts) --------------

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-m365-mail.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-m365-mail.virtual.js");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => licensed && f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee" || request === "../../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const shared = require("../src/lib/helpdesk/m365-mail-shared") as typeof import("../src/lib/helpdesk/m365-mail-shared");
const graphLib = require("../src/lib/helpdesk/m365/graph") as typeof import("../src/lib/helpdesk/m365/graph");
const message = require("../src/lib/helpdesk/m365/message") as typeof import("../src/lib/helpdesk/m365/message");
const m365 = require("../src/lib/helpdesk/m365/mail") as typeof import("../src/lib/helpdesk/m365/mail");
const m365Send = require("../src/lib/helpdesk/m365/send") as typeof import("../src/lib/helpdesk/m365/send");
const m365State = require("../src/lib/helpdesk/m365/state") as typeof import("../src/lib/helpdesk/m365/state");
const rules = require("../src/lib/helpdesk/intake/email-rules") as typeof import("../src/lib/helpdesk/intake/email-rules");
const mailboxes = require("../src/lib/helpdesk/mailboxes") as typeof import("../src/lib/helpdesk/mailboxes");
const sendAddresses = require("../src/lib/helpdesk/send-addresses") as typeof import("../src/lib/helpdesk/send-addresses");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const settingsLib = require("../src/lib/helpdesk/settings") as typeof import("../src/lib/helpdesk/settings");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const rootRoute = require("../src/app/api/helpdesk/admin/m365-mail/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/route");
const accessRoute = require("../src/app/api/helpdesk/admin/m365-mail/check-access/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/check-access/route");
const boxesRoute = require("../src/app/api/helpdesk/admin/m365-mail/mailboxes/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/mailboxes/route");
const boxRoute = require("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/route");
const checkRoute = require("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/check/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/check/route");
const linkRoute = require("../src/app/api/helpdesk/admin/m365-mail/addresses/[id]/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/addresses/[id]/route");
const testRoute = require("../src/app/api/helpdesk/admin/mailboxes/[id]/test/route") as typeof import("../src/app/api/helpdesk/admin/mailboxes/[id]/test/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";
import type { HdMailbox } from "../src/lib/helpdesk/mailboxes-shared";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdm365${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const DOMAIN = `${STAMP}.example.test`;
const HELP = `help@${DOMAIN}`;
const BILLING = `billing@${DOMAIN}`; // an alias on the help@ mailbox
const SALES = `sales@${DOMAIN}`; // a second mailbox
const OTHER = `ceo@${DOMAIN}`; // a mailbox the desk must not reach
const LOCK = 728351;
const KEY = m365State.M365_MAIL_KEY;
type Person = { id: number; email: string; session: string; name: string };
const U: Record<"req" | "agent" | "manager" | "outsider", Person> = {} as never;
let teamA = 0;
let teamB = 0;
let boxHelp: HdMailbox;
let boxBilling: HdMailbox;
let boxSales: HdMailbox;
let fake: FakeM365;
let app: FakeApp;
let SECRET = "";
let helpId = 0; // the connected Microsoft 365 mailbox help@
const smtp: HelpdeskOutgoingMail[] = [];
const ticketIds: number[] = [];
let lockClient: PoolClient | null = null;
let savedConfig: string | undefined;
let savedSettings = { outside_senders: false, inbound_secret: "", inbound_address: "", email_from_name: "" };
let savedAuth: string | undefined;

const by = () => ({ actor: { id: U.manager.id, name: U.manager.name, role: "viewer" as const } });
const cfg = () => m365.getM365Config();
const row = async (id = helpId) => (await pool().query("SELECT * FROM hd_m365_mailboxes WHERE id = $1", [id])).rows[0];
const poll = async (id = helpId) => m365.pollM365Mailbox(await cfg(), id);
const audits = async (action: string) => (await pool().query("SELECT details, actor_name FROM audit_log WHERE action = $1 AND at > now() - interval '1 hour' ORDER BY id", [action])).rows;

function req(url: string, who: Person | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.94", origin: "http://localhost", host: "localhost" };
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

const API = "http://localhost/api/helpdesk/admin/m365-mail";

// The notification endpoint as Microsoft reaches it: a listener that hands each POST to the handler and runs its work.
let bridge: http.Server;
let bridgeOrigin = "";
let pending: Promise<unknown>[] = [];
const bridgeLog: { status: number; path: string }[] = [];
const settled = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

function inboxMessage(over: Partial<FakeMessage> & { fromDomainResults?: string; authAs?: string[]; senderHeaders?: [string, string][]; headerTo?: string } = {}, mailbox = HELP): FakeMessage {
  const { fromDomainResults, authAs, senderHeaders, headerTo, ...rest } = over;
  const from = rest.from === undefined ? { name: "Cara Customer", address: `${newToken().slice(0, 10)}@customer.example` } : rest.from;
  const internetMessageId = rest.internetMessageId ?? `<${newToken()}@mail.sender.example>`;
  const to = rest.to ?? [{ name: "", address: mailbox }];
  const subject = rest.subject ?? `${STAMP} A question ${newToken().slice(0, 6)}`;
  return fake.addMessage(mailbox, {
    ...rest,
    from,
    to,
    subject,
    internetMessageId,
    headers:
      rest.headers ??
      exchangeHeaders({
        from: from ? `${from.name} <${from.address}>` : "",
        to: headerTo ?? to.map((a) => a.address).join(", "),
        cc: (rest.cc ?? []).map((a) => a.address).join(", ") || undefined,
        messageId: internetMessageId.replace(/^<|>$/g, ""),
        subject,
        results: fromDomainResults === undefined ? (from ? passResults(from.address.split("@")[1]) : undefined) : fromDomainResults || undefined,
        authAs: authAs ?? ["Anonymous"],
        sender: senderHeaders,
      }),
  });
}

async function ticketFor(subject: string) {
  const r = (await pool().query("SELECT id, number, team_id, mailbox_id, requester_id, requester_email, reply_token, status FROM hd_tickets WHERE subject = $1 ORDER BY id", [subject])).rows;
  for (const t of r) if (!ticketIds.includes(t.id)) ticketIds.push(t.id);
  return r as { id: number; number: number; team_id: number | null; mailbox_id: number | null; requester_id: number | null; requester_email: string; reply_token: string | null; status: string }[];
}
const seen = async (id: string, mailboxId = helpId) => (await pool().query("SELECT state, outcome, attempts, filed, error FROM hd_m365_messages WHERE mailbox_id = $1 AND message_id = $2", [mailboxId, id])).rows[0];

before(async () => {
  await getSetting("__schema_bootstrap__");
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
  savedConfig = await getSetting(KEY);
  savedAuth = await getSetting(inbound.HD_INBOUND_AUTH_KEY);
  const s = await settingsLib.getHelpdeskSettings();
  // The first address listed becomes the default and is mirrored into these two (lib/helpdesk/mailboxes): put back in after().
  savedSettings = { outside_senders: s.outside_senders, inbound_secret: s.inbound_secret, inbound_address: s.inbound_address, email_from_name: s.email_from_name };
  assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_mailboxes")).rows[0].n, 0, "this suite needs a database with no Microsoft 365 mailbox connected");
  await pool().query("DELETE FROM settings WHERE key = $1", [KEY]);
  m365State.resetM365StateForTests();

  fake = await startFakeM365();
  process.env.COMPASSDOCS_M365_MAIL_TEST_BASE = fake.base;
  process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE = `${fake.base}/login`;
  process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE = `${fake.base}/graph`;
  for (const [a, kind] of [[HELP, "shared"], [SALES, "user"], [OTHER, "user"], [`team@${DOMAIN}`, "group"], [`all@${DOMAIN}`, "distribution_list"], [`partner@${DOMAIN}`, "contact"]] as const) fake.addMailbox(a, kind);
  app = fake.addApp();
  SECRET = app.secrets[0];

  bridge = http.createServer((q, res) => {
    const chunks: Buffer[] = [];
    q.on("data", (c) => chunks.push(c));
    q.on("end", () => {
      const m = (q.url ?? "").match(/^\/api\/helpdesk\/m365\/notify\/([^/?]+)/);
      if (!m || q.method !== "POST") {
        res.writeHead(404);
        return res.end();
      }
      const r = new Request(`${bridgeOrigin}${q.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
      m365
        .handleM365Notification(r, decodeURIComponent(m[1]), { ip: "198.51.100.1" })
        .then((a) => {
          bridgeLog.push({ status: a.status, path: q.url ?? "" });
          res.writeHead(a.status, a.text !== undefined ? { "content-type": "text/plain; charset=utf-8" } : {});
          res.end(a.text ?? "");
          if (a.work) pending.push(a.work());
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
  });
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", () => r()));
  bridgeOrigin = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

  const names = { req: "Daniel Okafor", agent: "Ana Kowalski", manager: "Mina Park", outsider: "Noor Haddad" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const addr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'UTC') RETURNING id`, [`${STAMP}-${k}`, `${name} ${STAMP.slice(-4)}`, addr]);
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: addr, session, name: `${name} ${STAMP.slice(-4)}` };
  }
  for (const [k, role] of [["agent", "agent"], ["manager", "manager"]] as const) {
    await fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`, [U[k].id, role === "manager" ? "helpdesk-manager" : "helpdesk-agent"]);
    await fixtureQuery("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [U[k].id, role]);
  }
  teamA = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9960) RETURNING id", [`${STAMP} Support`])).rows[0].id;
  teamB = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9961) RETURNING id", [`${STAMP} Billing`])).rows[0].id;
  for (const t of [teamA, teamB]) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [t, U.agent.id]);
  boxHelp = await mailboxes.createMailbox({ address: HELP, name: "Acme Help", team_id: teamA }, by());
  boxBilling = await mailboxes.createMailbox({ address: BILLING, name: "Acme Billing", team_id: teamB }, by());
  boxSales = await mailboxes.createMailbox({ address: SALES, name: "Acme Sales" }, by());
  // The rules under test read the workspace's own settings.
  await settingsLib.saveHelpdeskSettings({ outside_senders: true, inbound_secret: "" }, { syncMailboxes: false });
  await inbound.saveInboundAuthSettings({ trust_unverified_senders: false });
  email.setHelpdeskTransportForTests(async (m) => {
    smtp.push(m);
  });
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  const ids = Object.values(U).map((u) => u.id);
  const teams = [teamA, teamB];
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR id = ANY($3) OR subject LIKE $4", [teams, ids, ticketIds, `%${STAMP}%`])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_m365_mailboxes");
  await pool().query("DELETE FROM hd_mailboxes WHERE address LIKE $1", [`%@${DOMAIN}`]);
  await pool().query("DELETE FROM hd_send_addresses WHERE address LIKE $1", [`%@${DOMAIN}`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teams]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM audit_log WHERE action LIKE 'helpdesk.m365.%' AND at > now() - interval '2 hours'");
  await pool().query("DELETE FROM audit_log WHERE target_type IN ('helpdesk_mailbox', 'helpdesk_send_address', 'helpdesk_inbound') AND (target_label LIKE $1 OR target_label LIKE $2)", [`%${DOMAIN}`, `${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  // The workspace's own settings, as found; no Microsoft 365 connection is left behind.
  await pool().query("DELETE FROM settings WHERE key = $1", [KEY]);
  if (savedConfig !== undefined) await setSetting(KEY, savedConfig);
  if (savedAuth === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [inbound.HD_INBOUND_AUTH_KEY]);
  else await setSetting(inbound.HD_INBOUND_AUTH_KEY, savedAuth);
  await settingsLib.saveHelpdeskSettings(savedSettings, { syncMailboxes: false });
  mailboxes.resetMailboxesReadyForTests();
  await new Promise((r) => bridge.close(() => r(null)));
  await fake.close();
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    lockClient.release();
  }
  await pool().end();
});

// --- Pure ---------------------------------------------------------------------------

describe("Microsoft's sender verdict", () => {
  const verdict = (o: Parameters<typeof exchangeHeaders>[0] & { fromEmail: string }) => {
    const list = message.graphHeaderList(exchangeHeaders(o));
    const v = message.m365Verdict(list, o.fromEmail);
    return { v, state: rules.authVerdict({ provider: "generic", from: o.fromEmail, headerList: [], headers: {}, auth: v.auth }) };
  };
  const base = { from: "Cara <cara@customer.example>", to: "help@acme.example", messageId: "m1@x", fromEmail: "cara@customer.example" };

  test("pass: Exchange's own results, aligned with the From domain", () => {
    const { v, state } = verdict({ ...base, results: passResults("customer.example"), authAs: ["Anonymous"] });
    assert.equal(v.kind, "results");
    assert.deepEqual(v.auth, { spf: "pass", envelopeFrom: "customer.example", dkim: "{@customer.example : pass}", dmarc: "pass" });
    assert.equal(state.state, "pass");
  });

  test("fail: a failed DMARC is never trusted, and compauth=fail overrules a pass elsewhere", () => {
    assert.equal(verdict({ ...base, results: failResults("customer.example"), authAs: ["Anonymous"] }).state.state, "fail");
    const mixed = verdict({ ...base, results: "spf=pass (sender IP is 203.0.113.9) smtp.mailfrom=customer.example; dkim=none header.d=none;dmarc=none action=none header.from=customer.example;compauth=fail reason=001", authAs: ["Anonymous"] });
    assert.equal(mixed.v.auth?.dmarc, "fail");
    assert.equal(mixed.state.ok, false);
  });

  test("a pass for another domain is not a pass for the From address", () => {
    // SPF passes for the bulk sender's own envelope domain; DMARC was evaluated for a From domain the message does not show.
    const r = verdict({ ...base, results: "spf=pass smtp.mailfrom=bulk.example; dkim=pass (signature was verified) header.d=bulk.example;dmarc=pass action=none header.from=bulk.example;compauth=pass reason=100", authAs: ["Anonymous"] });
    assert.equal(r.v.auth?.dmarc, "none");
    assert.equal(r.state.ok, false);
    assert.match(r.state.reason, /not aligned/);
  });

  test("none: no header from Exchange, or results that are all 'none'", () => {
    assert.deepEqual(verdict({ ...base, results: undefined, authAs: [] }).v, { kind: "none" });
    assert.equal(verdict({ ...base, results: undefined, authAs: [] }).state.state, "none");
    const empty = verdict({ ...base, results: "spf=none (sender IP is 203.0.113.9) smtp.mailfrom=customer.example; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=customer.example;compauth=none reason=405", authAs: ["Anonymous"] });
    assert.equal(empty.v.kind, "none");
    assert.equal(empty.state.state, "none");
  });

  test("a forged Authentication-Results below Exchange's is never read", () => {
    const forged: [string, string][] = [["Authentication-Results", `mx.customer.example; ${passResults("customer.example")}`]];
    const r = verdict({ ...base, results: failResults("customer.example"), authAs: ["Anonymous"], sender: forged });
    assert.equal(r.state.state, "fail");
    // And the header list handed to the pipeline is empty, so the generic header rule cannot pick the forged one up either.
    const conv = message.graphMessageToInbound({ id: "1", from: { emailAddress: { address: "cara@customer.example" } }, body: { contentType: "text", content: "x" }, internetMessageHeaders: exchangeHeaders({ ...base, results: undefined, authAs: [], sender: forged }) }, [], []);
    assert.deepEqual(conv?.email.headerList, []);
    // (No Exchange header at all is the one case the first header is the sender's: see the report's "not tested against real Microsoft 365".)
    assert.ok(conv?.email.headers["authentication-results"]);
  });

  test("internal mail: Exchange's own 'Internal' stamp, and only that", () => {
    const internal = { ...base, from: "Ana <ana@acme.example>", fromEmail: "ana@acme.example" };
    const ok = verdict({ ...internal, results: "dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=acme.example;", authAs: ["Internal"] });
    assert.equal(ok.v.kind, "internal");
    assert.equal(ok.state.state, "pass");
    assert.equal(verdict({ ...internal, results: undefined, authAs: ["Internal"] }).v.kind, "internal");
    // Two stamps (one planted, one Exchange's), another value, or the sending tenant's CrossTenant header: not internal.
    assert.notEqual(verdict({ ...internal, results: undefined, authAs: ["Anonymous", "Internal"] }).v.kind, "internal");
    assert.notEqual(verdict({ ...internal, results: undefined, authAs: ["Partner"] }).v.kind, "internal");
    assert.notEqual(verdict({ ...internal, results: undefined, authAs: [], sender: [["X-MS-Exchange-CrossTenant-AuthAs", "Internal"]] }).v.kind, "internal");
    // A planted "Internal" on mail from outside: Exchange's SPF verdict (always there for outside mail) or a failed DMARC shows it.
    assert.notEqual(verdict({ ...internal, results: "spf=softfail (sender IP is 198.51.100.7) smtp.mailfrom=acme.example; dkim=none header.d=none;dmarc=none action=none header.from=acme.example;compauth=none reason=405", authAs: ["Internal"] }).v.kind, "internal");
    assert.equal(verdict({ ...internal, results: failResults("acme.example"), authAs: ["Internal"] }).state.state, "fail");
  });

  test("hostile header values: long, nested comments, many segments", () => {
    const long = `spf=pass (${"a".repeat(5000)}) smtp.mailfrom=customer.example; ${"dkim=pass header.d=x.example;".repeat(200)}`;
    const t0 = Date.now();
    const r = message.parseExchangeResults(long);
    assert.ok(Date.now() - t0 < 200);
    assert.ok(r.dkim.length <= 8);
    assert.equal(message.parseExchangeResults("spf=pass smtp.mailfrom=bad domain!; dmarc=pass header.from=<script>").spfDomain, "");
    assert.equal(message.graphHeaderList(Array.from({ length: 2000 }, (_, i) => ({ name: `X-${i}`, value: "v" }))).length, 500);
  });
});

describe("a Graph message as an InboundEmail", () => {
  const TOKEN = "k7q2xz9m4pqa1b2c";
  const msg = (over: Record<string, unknown>) => ({
    id: "AAMk1",
    internetMessageId: "<abc@mail.sender.example>",
    subject: "Hello\r\nthere",
    from: { emailAddress: { name: "Cara Customer", address: "Cara@Customer.example" } },
    toRecipients: [{ emailAddress: { name: "Help", address: "help@acme.example" } }],
    ccRecipients: [],
    body: { contentType: "html", content: "<p>Hi <b>there</b></p>" },
    internetMessageHeaders: exchangeHeaders({ from: "Cara <cara@customer.example>", to: "help@acme.example", messageId: "abc@mail.sender.example", results: passResults("customer.example"), authAs: ["Anonymous"] }),
    ...over,
  });

  test("the fields the pipeline reads", () => {
    const { email: e, verdict } = message.graphMessageToInbound(msg({}), [], ["help@acme.example"])!;
    assert.equal(e.provider, "generic");
    assert.deepEqual(e.from, { email: "cara@customer.example", name: "Cara Customer" });
    assert.equal(e.subject, "Hello there");
    assert.equal(e.messageId, "abc@mail.sender.example");
    assert.equal(e.html, "<p>Hi <b>there</b></p>");
    assert.equal(e.text, "");
    assert.deepEqual(e.recipients, ["help@acme.example"]);
    assert.equal(verdict.kind, "results");
    assert.equal(rules.emailAuthVerdict(e).state, "pass");
    assert.equal(message.graphMessageToInbound({ id: "x", body: {} }, [], []), null, "no sender: nothing to work with");
  });

  test("an alias: the To line keeps what the sender typed although Graph shows the main address", () => {
    const boxes = [{ address: "help@acme.example" }, { address: "billing@acme.example" }];
    const alias = message.graphMessageToInbound(
      msg({ internetMessageHeaders: exchangeHeaders({ from: "Cara <cara@customer.example>", to: "Billing <billing@acme.example>", messageId: "a@x", results: passResults("customer.example") }) }),
      [],
      ["help@acme.example", "billing@acme.example"]
    )!.email;
    assert.deepEqual(alias.to.map((a) => a.email), ["billing@acme.example", "help@acme.example"]);
    const { mailboxForRecipients } = require("../src/lib/helpdesk/mailboxes-shared") as typeof import("../src/lib/helpdesk/mailboxes-shared"); // eslint-disable-line @typescript-eslint/no-require-imports
    assert.equal(mailboxForRecipients(boxes, alias)?.address, "billing@acme.example");
    // On Bcc (nothing names ours): the mailbox's first help address, never another mailbox's.
    const bcc = message.graphMessageToInbound(msg({ toRecipients: [], internetMessageHeaders: exchangeHeaders({ from: "c@customer.example", to: "bob@elsewhere.example", messageId: "b@x" }) }), [], ["help@acme.example", "billing@acme.example"])!.email;
    assert.equal(mailboxForRecipients([{ address: "sales@acme.example" }, ...boxes], bcc)?.address, "help@acme.example");
    // A reply's plus tag is on the To line, and found.
    const reply = message.graphMessageToInbound(msg({ internetMessageHeaders: exchangeHeaders({ from: "c@customer.example", to: `billing+hd-${TOKEN}@acme.example`, messageId: "c@x" }) }), [], ["help@acme.example", "billing@acme.example"])!.email;
    const { findReplyToken } = require("../src/lib/helpdesk/inbound-parse") as typeof import("../src/lib/helpdesk/inbound-parse"); // eslint-disable-line @typescript-eslint/no-require-imports
    assert.equal(findReplyToken(reply), TOKEN);
    assert.equal(mailboxForRecipients(boxes, reply)?.address, "billing@acme.example");
  });
});

describe("the restrict-access commands, links and addresses", () => {
  const ids = { clientId: "f9c3ef03-83fb-4d50-ae7e-4296271ca096", spObjectId: "0b6c1e5f-7a2d-4b8e-9c31-0d4e6f7a8b92" };

  test("the first-time block names the app, the scope and both roles; nothing tenant-wide", () => {
    const text = shared.restrictCommands({ ...ids, addresses: ["help@acme.com", "Billing@acme.com", "help@acme.com"], first: true })!;
    const lines = text.split("\n");
    assert.equal(lines[0], "Connect-ExchangeOnline");
    assert.equal(lines[1], `New-ServicePrincipal -AppId ${ids.clientId} -ObjectId ${ids.spObjectId} -DisplayName "CompassDocs Helpdesk Mail"`);
    assert.equal(lines[2], `New-ManagementScope -Name "CompassDocs help mailboxes" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'help@acme.com' -or PrimarySmtpAddress -eq 'billing@acme.com'"`);
    assert.match(lines[3], /-Role "Application Mail\.ReadWrite" -CustomResourceScope "CompassDocs help mailboxes"$/);
    assert.match(lines[4], /-Role "Application Mail\.Send" -CustomResourceScope "CompassDocs help mailboxes"$/);
    assert.match(lines[5], /^Test-ServicePrincipalAuthorization -Identity 0b6c1e5f-\S+ -Resource help@acme\.com/);
    assert.equal(lines.length, 6);
    const later = shared.restrictCommands({ ...ids, addresses: ["help@acme.com"], first: false })!;
    assert.match(later, /^Connect-ExchangeOnline\nSet-ManagementScope -Identity "CompassDocs help mailboxes"/);
    assert.doesNotMatch(later, /New-ServicePrincipal/);
    // A quote in an address cannot end the PowerShell string.
    assert.match(shared.scopeFilter(["o'brien@acme.com"]), /'o''brien@acme\.com'/);
    assert.equal(shared.restrictCommands({ ...ids, addresses: [], first: true }), null);
    assert.equal(shared.restrictCommands({ clientId: ids.clientId, spObjectId: "", addresses: ["a@b.co"], first: true }), null);
  });

  test("the manual form's rules", () => {
    assert.equal(shared.m365CredentialsProblem({ tenant: "", client_id: "", secret: "" }), "Enter the tenant ID.");
    assert.match(shared.m365CredentialsProblem({ tenant: "not a tenant", client_id: ids.clientId, secret: "s" }), /GUID\) or a domain/);
    assert.match(shared.m365CredentialsProblem({ tenant: "contoso.onmicrosoft.com", client_id: "nope", secret: "s" }), /client\) ID is a GUID/);
    assert.equal(shared.m365CredentialsProblem({ tenant: ids.clientId, client_id: ids.clientId, secret: "" }), "Enter the client secret's value.");
    assert.equal(shared.m365CredentialsProblem({ tenant: ids.clientId, client_id: ids.clientId, secret: "" }, true), "");
    assert.equal(shared.cleanFolderName("  Done/and\\dusted\n "), "Done and dusted");
  });

  test("a link from Graph is followed only on the Graph host; the seam is loopback only", () => {
    const base = process.env.COMPASSDOCS_M365_MAIL_TEST_BASE!;
    assert.equal(graphLib.graphLink(`${base}/graph/v1.0/users/a/mailFolders/inbox/messages/delta?$deltatoken=4`), `${base}/graph/v1.0/users/a/mailFolders/inbox/messages/delta?$deltatoken=4`);
    for (const bad of ["http://evil.example/v1.0/x", `${base}/graph/beta/x`, `${base}/login/x`, `${base.replace("127.0.0.1", "user:pw@127.0.0.1")}/graph/v1.0/x`, "not a link", ""]) {
      assert.throws(() => graphLib.graphLink(bad), graphLib.M365Error, bad);
    }
    const keep = process.env.COMPASSDOCS_M365_MAIL_TEST_BASE;
    for (const off of ["https://graph.attacker.example", "http://10.0.0.5:4000", "http://127.0.0.1:4000/path", "http://127.0.0.1.evil.example:4000"]) {
      process.env.COMPASSDOCS_M365_MAIL_TEST_BASE = off;
      assert.equal(graphLib.m365TestBase(), null, off);
    }
    delete process.env.COMPASSDOCS_M365_MAIL_TEST_BASE;
    // Without the seam: the real host, and a loopback or private address is no place for notifications.
    assert.equal(graphLib.graphLink("https://graph.microsoft.com/v1.0/users/a/messages/delta?$skiptoken=x"), "https://graph.microsoft.com/v1.0/users/a/messages/delta?$skiptoken=x");
    assert.throws(() => graphLib.graphLink("https://graph.microsoft.com.evil.example/v1.0/x"), graphLib.M365Error);
    assert.throws(() => graphLib.graphLink("http://graph.microsoft.com/v1.0/x"), graphLib.M365Error);
    assert.equal(m365.notifyBase("https://desk.acme.com"), "https://desk.acme.com");
    for (const no of ["http://desk.acme.com", "http://localhost:3000", "https://localhost", "https://10.1.2.3", "https://192.168.1.4", "https://desk.internal", "https://intranet", "nonsense"]) assert.equal(m365.notifyBase(no), null, no);
    process.env.COMPASSDOCS_M365_MAIL_TEST_BASE = keep;
    assert.equal(m365.notifyBase("http://127.0.0.1:3997"), "http://127.0.0.1:3997", "the rig's fake Microsoft may call back over loopback http");
  });

  test("an app token's claims: read, never trusted for more than they are", () => {
    const jwt = (c: unknown) => `x.${Buffer.from(JSON.stringify(c)).toString("base64url")}.y`;
    assert.deepEqual(graphLib.tokenClaims(jwt({ tid: "8F4C2B7E-3D1A-4E6F-9B2C-5A7D1E0F4C93", oid: "0b6c1e5f-7a2d-4b8e-9c31-0d4e6f7a8b92", roles: ["Mail.ReadWrite", 5, "bad role!"] })), {
      tid: "8f4c2b7e-3d1a-4e6f-9b2c-5a7d1e0f4c93",
      oid: "0b6c1e5f-7a2d-4b8e-9c31-0d4e6f7a8b92",
      roles: ["Mail.ReadWrite"],
    });
    assert.deepEqual(graphLib.tokenClaims("garbage"), { tid: "", oid: "", roles: [] });
    assert.deepEqual(graphLib.tokenClaims(jwt({ tid: "<script>", oid: 5 })), { tid: "", oid: "", roles: [] });
  });
});

// --- The upgrade: nothing configured ----------------------------------------------------

describe("an install that never connects Microsoft 365", () => {
  test("the schema is there, the view says not connected, and nothing calls Microsoft", async () => {
    for (const t of ["hd_m365_mailboxes", "hd_m365_messages", "hd_m365_links"]) assert.equal((await pool().query("SELECT to_regclass($1) AS t", [t])).rows[0].t, t);
    const v = await m365.m365MailView("https://desk.acme.com");
    assert.equal(v.connected, false);
    assert.deepEqual([v.mailboxes, v.links, v.access, v.orphaned], [[], [], null, false]);
    assert.equal(await getSetting(KEY), undefined, "reading the view writes nothing");
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_m365_mail"));
    const before = fake.log.length;
    assert.deepEqual(await m365.m365MailSweep(), { polled: 0 });
    const state = await m365State.m365State();
    assert.deepEqual([state.configured, state.linked.size, state.sendVia.size], [false, 0, 0]);
    assert.equal(await m365Send.sendThroughM365(boxHelp.id, HELP, "Acme Help", { to: "a@b.example", from: "x@y.example", subject: "s", text: "t", html: "<p>t</p>", headers: {} }), "not_chosen");
    assert.equal(fake.log.length, before, "no request left for Microsoft");
    await assert.rejects(m365.connectM365Mailbox(HELP, by()), (e: Error & { status?: number }) => e.status === 409 && /Connect Microsoft 365 first/.test(e.message));
    await assert.rejects(m365.checkM365Access({}, by()), /Connect Microsoft 365 first/);
  });

  test("the notification address answers nobody: 404 whatever is sent", async () => {
    m365.resetM365NotifyLimitsForTests();
    for (const url of ["http://localhost/api/helpdesk/m365/notify/anything?validationToken=hello", "http://localhost/api/helpdesk/m365/notify/anything"]) {
      const a = await m365.handleM365Notification(new Request(url, { method: "POST", body: JSON.stringify({ value: [{ subscriptionId: "x", clientState: "y" }] }) }), "anything", { ip: "198.51.100.9" });
      assert.deepEqual(a, { status: 404 });
    }
  });

  test("outgoing mail is as it was: the workspace transport, no reply address while inbound email is off", async () => {
    smtp.length = 0;
    const { createTicket } = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets"); // eslint-disable-line @typescript-eslint/no-require-imports
    const t = await createTicket({ subject: `${STAMP} upgrade`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, via: "portal", source: "portal", team_id: teamA, mailbox_id: boxHelp.id }, { actorId: U.req.id, actorName: U.req.name });
    ticketIds.push(t.id);
    await messages.addMessage(t.id, { kind: "public", body: "On it.", author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" }, { actorId: U.agent.id, actorName: U.agent.name });
    await new Promise((r) => setTimeout(r, 400));
    const toReq = smtp.filter((m) => m.to === U.req.email);
    assert.ok(toReq.length >= 1);
    for (const m of toReq) assert.equal(m.replyTo, undefined);
  });
});

// --- The connection -----------------------------------------------------------------

describe("the connection (manual form)", () => {
  test("refusals: a bad shape, a wrong secret (Microsoft's reason, never the secret), an unknown app", async () => {
    await assert.rejects(m365.saveM365Connection({ tenant: fake.tenantId, client_id: "nope", secret: "x" }, by()), /client\) ID is a GUID/);
    const wrong = "definitely-not-the-secret-0123456789";
    await assert.rejects(m365.saveM365Connection({ tenant: fake.tenantId, client_id: app.appId, secret: wrong }, by()), (e: Error & { status?: number; code?: string }) => {
      assert.equal(e.status, 409);
      assert.equal(e.code, "signin");
      assert.match(e.message, /refused the app's sign-in \(AADSTS7000215\): the client secret is wrong or has expired/);
      assert.ok(!e.message.includes(wrong));
      return true;
    });
    await assert.rejects(m365.saveM365Connection({ tenant: fake.tenantId, client_id: "11111111-2222-3333-4444-555555555555", secret: "x" }, by()), /no app registration with that client ID/);
    assert.equal((await cfg()).secret, "", "nothing was saved");
    // Microsoft down: 502, nothing saved.
    fake.fail.token = 503;
    await assert.rejects(m365.saveM365Connection({ tenant: fake.tenantId, client_id: app.appId, secret: SECRET }, by()), (e: Error & { status?: number }) => e.status === 502);
    fake.fail = {};
  });

  test("saved after signing in: the tenant and the app's object ID come from the token; the secret is sealed and audited as 'changed', never shown", async () => {
    const res = await call(rootRoute.PUT, req(API, U.manager, { tenant: "contoso.example", client_id: app.appId.toUpperCase(), secret: ` ${SECRET} ` }, "PUT"));
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.created, res.body.verified], [true, true]);
    const v = res.body.view;
    assert.deepEqual([v.connected, v.tenant, v.client_id, v.sp_object_id, v.secret_set, v.setup], [true, fake.tenantId, app.appId, app.spId, true, "manual"]);
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
    const stored = (await pool().query("SELECT value FROM settings WHERE key = $1", [KEY])).rows[0].value as string;
    assert.ok(!stored.includes(SECRET), "sealed at rest");
    assert.equal((await cfg()).secret, SECRET);
    const a = (await audits("helpdesk.m365.connection_saved")).at(-1)!;
    assert.deepEqual([a.details.created, a.details.tenant, a.details.client_id, a.details.setup, a.details.verified], [true, fake.tenantId, app.appId, "manual", true]);
    assert.ok(!JSON.stringify(a.details).includes(SECRET));
    assert.ok(auditLabels.hasActionLabel("helpdesk.m365.connection_saved"));
    assert.equal((await m365State.m365State()).configured, true);
    // An empty secret keeps the saved one for the same app.
    const again = await m365.saveM365Connection({ tenant: fake.tenantId, client_id: app.appId, secret: "" }, by());
    assert.equal(again.created, false);
    assert.equal((await cfg()).secret, SECRET);
  });
});

// --- Mailboxes ------------------------------------------------------------------------

describe("connecting mailboxes", () => {
  test("not a mailbox: a group, a distribution list, a contact, an unknown address are refused with what to use instead", async () => {
    // The app can see the organisation for this one (granted in Entra), so Microsoft says what each address is.
    app.roles = ["Mail.ReadWrite"];
    graphLib.clearM365TokensForTests();
    for (const a of [`team@${DOMAIN}`, `all@${DOMAIN}`, `partner@${DOMAIN}`, `nobody@${DOMAIN}`, "someone@another-org.example"]) {
      const r = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: a }));
      assert.equal(r.status, 422, a);
      assert.equal(r.body.code, "not_a_mailbox");
      assert.match(r.body.error, /found no mailbox with that address\. Distribution lists, Microsoft 365 groups, mail contacts and mailboxes in another organisation can't be connected\. Use a shared mailbox instead\./);
    }
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_mailboxes")).rows[0].n, 0);
    assert.match((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: "help+x@acme.example" }))).body.error, /\+ tag/);
    assert.equal((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: "nope" }))).status, 400);
    app.roles = [];
    graphLib.clearM365TokensForTests();
  });

  test("a mailbox the app may not read yet is listed, waiting; its help address is linked; the access check says so", async () => {
    const r = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: ` ${HELP.toUpperCase()} ` }));
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.mailbox.address, r.body.mailbox.waiting, r.body.mailbox.linked], [HELP, true, HELP]);
    helpId = r.body.mailbox.id;
    const mb = r.body.view.mailboxes[0];
    assert.match(mb.last_error, /has not let the app read this mailbox yet\. Run the commands under Limit access/);
    assert.deepEqual(mb.addresses, [{ id: boxHelp.id, address: HELP, send_via: false }]);
    assert.equal((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: HELP }))).status, 409);
    assert.deepEqual((await audits("helpdesk.m365.mailbox_connected")).at(-1)!.details, { address: HELP, waiting_for_access: true, linked_help_address: HELP });

    // The commands the page shows are for this app and this mailbox.
    const v = r.body.view;
    const text = shared.restrictCommands({ clientId: v.client_id, spObjectId: v.sp_object_id, addresses: v.mailboxes.map((m: { address: string }) => m.address), first: true })!;
    assert.ok(text.includes(`-AppId ${app.appId} -ObjectId ${app.spId}`) && text.includes(`'${HELP}'`));

    const check = await call(accessRoute.POST, req(`${API}/check-access`, U.manager, { probe: OTHER }));
    assert.equal(check.status, 200);
    assert.deepEqual(check.body.access.tenant_wide, []);
    assert.equal(check.body.access.mailboxes[0].ok, false);
    assert.match(check.body.access.mailboxes[0].error, /not allowed to reach this mailbox/);
    assert.deepEqual([check.body.access.probe.reachable, check.body.access.probe.note], [false, "Microsoft 365 refused, as it should. The app can't read this mailbox."]);
    // A read while waiting keeps the same sentence, and takes nothing in.
    assert.equal((await poll()).ok, false);
    assert.match((await row()).last_error, /Run the commands under Limit access/);
  });

  test("after the admin ran the commands: reachable, and only the help mailboxes", async () => {
    // What the PowerShell block grants: the scope, for reading and for sending.
    app.scope = new Set([HELP, SALES]);
    app.sendScope = new Set([HELP]);
    const check = await call(accessRoute.POST, req(`${API}/check-access`, U.manager, { probe: OTHER }));
    assert.deepEqual(check.body.access.mailboxes, [{ address: HELP, ok: true, error: "" }]);
    assert.equal(check.body.access.probe.reachable, false);
    assert.equal((await row()).last_error, "", "no longer waiting");
    const a = (await audits("helpdesk.m365.access_checked")).at(-1)!;
    assert.deepEqual([a.details.tenant_wide, a.details.reachable, a.details.probe, a.details.probe_reachable], [[], [HELP], OTHER, false]);
    // A second mailbox, already in scope: connected at once; a user mailbox works like a shared one.
    const sales = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: SALES }));
    assert.deepEqual([sales.status, sales.body.mailbox.waiting, sales.body.mailbox.linked], [201, false, SALES]);
  });

  test("an app that was given the whole organisation is called out", async () => {
    app.roles = ["Mail.ReadWrite", "Mail.Send", "User.Read.All"];
    const check = await call(accessRoute.POST, req(`${API}/check-access`, U.manager, { probe: OTHER }));
    assert.deepEqual(check.body.access.tenant_wide, ["Mail.ReadWrite", "Mail.Send"]);
    assert.deepEqual([check.body.access.probe.reachable, check.body.access.probe.note], [true, "The app can read this mailbox. It is not limited to your help mailboxes."]);
    assert.deepEqual((await m365.m365MailView()).access?.tenant_wide, ["Mail.ReadWrite", "Mail.Send"]);
    app.roles = [];
    const back = await call(accessRoute.POST, req(`${API}/check-access`, U.manager, {}));
    assert.deepEqual([back.body.access.tenant_wide, back.body.access.probe], [[], null]);
    assert.equal((await call(accessRoute.POST, req(`${API}/check-access`, U.manager, { probe: "not an address" }))).status, 400);
  });
});

// --- Intake by the timer ---------------------------------------------------------------

describe("reading a mailbox (delta query)", () => {
  test("mail that was there before the mailbox was connected is left alone; new mail becomes a ticket and is marked read", async () => {
    const old = inboxMessage({ subject: `${STAMP} old mail`, receivedDateTime: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const draft = inboxMessage({ subject: `${STAMP} a draft left in the Inbox`, isDraft: true });
    const fresh = inboxMessage({ subject: `${STAMP} printer on fire`, body: { contentType: "html", content: "<p>The <b>printer</b> is on fire.</p><script>alert(1)</script>" } });
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await ticketFor(`${STAMP} old mail`)).length, 0);
    assert.equal((await ticketFor(`${STAMP} a draft left in the Inbox`)).length, 0);
    const [t] = await ticketFor(`${STAMP} printer on fire`);
    assert.ok(t, "the new message opened a ticket");
    assert.deepEqual([t.mailbox_id, t.team_id, t.requester_id], [boxHelp.id, teamA, null]);
    const body = (await pool().query("SELECT body, via FROM hd_messages WHERE ticket_id = $1 AND via <> 'system' ORDER BY id LIMIT 1", [t.id])).rows[0];
    assert.equal(body.via, "email");
    assert.match(body.body, /printer.* is on fire/);
    assert.doesNotMatch(body.body, /script|alert/);
    const mb = fake.mailboxes.get(HELP)!;
    assert.equal(mb.messages.get(fresh.id)!.isRead, true);
    assert.equal(mb.messages.get(old.id)!.isRead, false);
    assert.equal(mb.messages.get(draft.id)!.isRead, false);
    assert.deepEqual(await seen(fresh.id), { state: "done", outcome: "created", attempts: 1, filed: true, error: "" });
    assert.equal(await seen(old.id), undefined);
    const r = await row();
    assert.deepEqual([r.taken_in, r.dropped, r.failed, r.last_error], [1, 0, 0, ""]);
    assert.ok(r.last_ok_at && r.delta_link.startsWith(`${fake.base}/graph/v1.0/`));
    // Again: nothing new (the "marked read" change comes back in the delta and is recognised).
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await ticketFor(`${STAMP} printer on fire`)).length, 1);
    assert.equal((await row()).taken_in, 1);
  });

  test("paging: every page of a round is read, and the link is kept only as the next round's start", async () => {
    const mb = fake.mailboxes.get(HELP)!;
    const before = fake.calls("/messages/delta").length;
    // 120 old messages around three new ones: more than two pages of 50.
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const subjects: string[] = [];
    for (let i = 0; i < 123; i++) {
      if (i === 5 || i === 60 || i === 118) {
        subjects.push(`${STAMP} page ${i}`);
        inboxMessage({ subject: subjects.at(-1)! });
      } else fake.addMessage(HELP, { subject: `${STAMP} filler`, receivedDateTime: old });
    }
    assert.deepEqual(await poll(), { ok: true });
    assert.equal(fake.calls("/messages/delta").length - before, 3, "three pages");
    for (const s of subjects) assert.equal((await ticketFor(s)).length, 1, s);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_messages WHERE mailbox_id = $1", [helpId])).rows[0].n, 4, "no record is kept of mail that was only skipped");
    assert.match((await row()).delta_link, /\$deltatoken=\d+$/);
    for (const [id, m] of mb.messages) if (m.subject === `${STAMP} filler`) fake.removeMessage(HELP, id);
  });

  test("a lost delta link (410): one full round, and nothing is taken in twice", async () => {
    const mb = fake.mailboxes.get(HELP)!;
    const extra = inboxMessage({ subject: `${STAMP} after the resync` });
    mb.expireDelta = true;
    const tickets = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE subject LIKE $1", [`${STAMP}%`])).rows[0].n;
    assert.deepEqual(await poll(), { ok: true });
    assert.equal(fake.calls(/messages\/delta 410/).length, 1);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE subject LIKE $1", [`${STAMP}%`])).rows[0].n, tickets + 1);
    assert.equal((await seen(extra.id)).outcome, "created");
  });

  test("a link to another host is never followed, and never stored", async () => {
    for (let i = 0; i < 60; i++) fake.addMessage(HELP, { subject: `${STAMP} filler`, receivedDateTime: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    const link = (await row()).delta_link;
    fake.evilNextLink = true;
    const r = await poll();
    fake.evilNextLink = false;
    assert.equal(r.ok, false);
    assert.match(r.error!, /sent a link to another address\. It was not followed\./);
    assert.equal((await row()).delta_link, link, "the stored link is unchanged");
    assert.ok(!fake.log.some((l) => l.includes("steal")));
    // A tampered stored link is dropped for a full round, not followed.
    await pool().query("UPDATE hd_m365_mailboxes SET delta_link = 'https://evil.example/v1.0/users/x/messages/delta?$deltatoken=1' WHERE id = $1", [helpId]);
    assert.deepEqual(await poll(), { ok: true });
    assert.ok((await row()).delta_link.startsWith(`${fake.base}/graph/v1.0/`));
    for (const [id, m] of fake.mailboxes.get(HELP)!.messages) if (m.subject === `${STAMP} filler`) fake.removeMessage(HELP, id);
    await poll();
  });
});

// --- The notification endpoint -----------------------------------------------------------

describe("change notifications", () => {
  let key = "";

  test("the sweep sets up a subscription per mailbox through the validation handshake", async () => {
    // The address Microsoft posts to is the one the admin opened the desk at (here: the test's listener).
    assert.deepEqual(await m365.saveM365Settings({ notify_origin: bridgeOrigin }, by()), ["notify_origin"]);
    // Opening the desk at another address afterwards does not move it.
    await m365.m365MailView("http://localhost:4999");
    const c = await cfg();
    key = c.notify_key;
    assert.ok(key.length >= 32);
    assert.equal(c.notify_origin, bridgeOrigin);
    m365.resetM365NotifyLimitsForTests();
    bridgeLog.length = 0;
    await m365.m365MailSweep();
    assert.equal(fake.subscriptions.size, 2);
    const sub = [...fake.subscriptions.values()].find((s) => s.mailbox === HELP)!;
    assert.deepEqual([sub.changeType, sub.resource, sub.notificationUrl, sub.lifecycleNotificationUrl], ["created", `users/${HELP}/mailFolders('inbox')/messages`, `${bridgeOrigin}/api/helpdesk/m365/notify/${key}`, `${bridgeOrigin}/api/helpdesk/m365/notify/${key}`]);
    assert.equal(sub.clientState.length, 64);
    const days = (Date.parse(sub.expirationDateTime) - Date.now()) / 86_400_000;
    assert.ok(days > 1.9 && days < 2.1, "two days, well inside Microsoft's limit");
    assert.ok(bridgeLog.filter((b) => b.status === 200 && b.path.includes("validationToken=")).length >= 2);
    const r = await row();
    assert.deepEqual([r.sub_id, r.sub_state, r.sub_error], [sub.id, sub.clientState, ""]);
    assert.equal((await m365.m365MailView()).mailboxes.find((m) => m.id === helpId)!.mode, "notifications");
    assert.match(shared.modeSentence("notifications", 2, bridgeOrigin), /Microsoft tells the desk when mail arrives/);
  });

  test("the handshake: the token comes back as plain text, only for the right key, only while licensed", async () => {
    m365.resetM365NotifyLimitsForTests();
    const url = (k: string, q = "?validationToken=Validation%3A+Testing+%3Cb%3E") => new Request(`http://localhost/api/helpdesk/m365/notify/${k}${q}`, { method: "POST" });
    assert.deepEqual(await m365.handleM365Notification(url(key), key), { status: 200, text: "Validation: Testing <b>" });
    assert.deepEqual(await m365.handleM365Notification(url("wrong-key"), "wrong-key", { ip: "198.51.100.20" }), { status: 404 });
    assert.deepEqual(await m365.handleM365Notification(url(`${key}x`), `${key}x`, { ip: "198.51.100.20" }), { status: 404 });
    assert.equal((await m365.handleM365Notification(url(key, `?validationToken=${"a".repeat(3000)}`), key)).status, 400);
    assert.equal((await m365.handleM365Notification(url(key, "?validationToken="), key)).status, 400);
    licensed = false;
    assert.deepEqual(await m365.handleM365Notification(url(key), key), { status: 402 });
    licensed = true;
    // Someone guessing keys is slowed down on their own; Microsoft's notifications are not.
    for (let i = 0; i < m365.M365_NOTIFY_LIMITS.perIpWrongKey; i++) await m365.handleM365Notification(url("guess"), "guess", { ip: "198.51.100.66" });
    assert.equal((await m365.handleM365Notification(url("guess"), "guess", { ip: "198.51.100.66" })).status, 429);
    assert.equal((await m365.handleM365Notification(url(key), key, { ip: "198.51.100.66" })).status, 200);
    // The route's source: no session gate, the work after the answer, text/plain with nosniff.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "app", "api", "helpdesk", "m365", "notify", "[key]", "route.ts"), "utf8");
    assert.ok(src.includes("after(r.work)") && src.includes("text/plain") && src.includes("nosniff") && !src.includes("Gate("));
  });

  test("a notification fetches the message from Graph at once; the body is trusted for nothing but the id", async () => {
    const m = inboxMessage({ subject: `${STAMP} notified` });
    const polls = fake.calls("/messages/delta").length;
    // The notification lies about everything it can: only the id (and the state) count.
    assert.equal(await fake.deliver(HELP, m.id, { resource: `Users/${OTHER}/Messages/zzz`, tenantId: "someone-else", subject: "injected", from: "ceo@acme.example" }), 202);
    await settled();
    const [t] = await ticketFor(`${STAMP} notified`);
    assert.ok(t);
    assert.equal(fake.calls("/messages/delta").length, polls, "no delta read was needed");
    assert.equal(fake.calls(encodeURIComponent(OTHER)).filter((l) => l.includes("/messages/")).length, 0, "the other mailbox was never asked");
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, true);
    assert.ok((await row()).last_notified_at);
  });

  test("without the subscription's clientState nothing happens, whatever else is right", async () => {
    const m = inboxMessage({ subject: `${STAMP} forged notification` });
    const sub = [...fake.subscriptions.values()].find((s) => s.mailbox === HELP)!;
    const post = async (item: Record<string, unknown>) => {
      const a = await m365.handleM365Notification(new Request(`http://localhost/api/helpdesk/m365/notify/${key}`, { method: "POST", body: JSON.stringify({ value: [item] }) }), key, { ip: "198.51.100.30" });
      if (a.work) await a.work();
      return a.status;
    };
    const good = { subscriptionId: sub.id, changeType: "created", resourceData: { id: m.id } };
    for (const item of [{ ...good, clientState: "" }, { ...good }, { ...good, clientState: "0".repeat(64) }, { ...good, clientState: sub.clientState.slice(0, 63) }, { ...good, subscriptionId: "unknown", clientState: sub.clientState }]) {
      assert.equal(await post(item), 202, "answered like any other, so nothing is learned");
    }
    assert.equal((await ticketFor(`${STAMP} forged notification`)).length, 0);
    assert.equal(await seen(m.id), undefined);
    // Not JSON, too large: refused before anything is read from the database.
    assert.equal((await m365.handleM365Notification(new Request(`http://localhost/api/helpdesk/m365/notify/${key}`, { method: "POST", body: "{nope" }), key)).status, 400);
    assert.equal((await m365.handleM365Notification(new Request(`http://localhost/api/helpdesk/m365/notify/${key}`, { method: "POST", body: "x".repeat(m365.M365_NOTIFY_LIMITS.bodyBytes + 1) }), key)).status, 413);
    // An id that is no id asks for a read instead; an "updated" notification is ignored.
    assert.equal(await post({ ...good, clientState: sub.clientState, changeType: "updated" }), 202);
    assert.equal(await seen(m.id), undefined);
    assert.equal(await post({ ...good, clientState: sub.clientState, resourceData: { id: "has space\n" } }), 202);
    assert.equal((await row()).poll_due, true);
    // The real one, at last.
    assert.equal(await post({ ...good, clientState: sub.clientState }), 202);
    assert.equal((await ticketFor(`${STAMP} forged notification`)).length, 1);
  });

  test("exactly once: the same message by notification, twice at the same moment, and then by the timer", async () => {
    const m = inboxMessage({ subject: `${STAMP} once only` });
    const [a, b, c] = await Promise.all([fake.deliver(HELP, m.id), fake.deliver(HELP, m.id), poll()]);
    await settled();
    assert.deepEqual([a, b], [202, 202]);
    assert.ok(c.ok || c.busy);
    await poll();
    assert.equal((await ticketFor(`${STAMP} once only`)).length, 1);
    assert.deepEqual([(await seen(m.id)).state, (await seen(m.id)).attempts], ["done", 1]);
    // A second copy of the same email (another Graph id, as after a restore): the pipeline's Message-ID rule drops it, and it is filed.
    const copy = fake.addMessage(HELP, { ...m, id: `${m.id}copy`, isRead: false });
    await poll();
    assert.equal((await ticketFor(`${STAMP} once only`)).length, 1);
    assert.deepEqual([(await seen(copy.id)).outcome, (await seen(copy.id)).filed], ["duplicate", true]);
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(copy.id)!.isRead, true);
  });

  test("a worker that died mid-message: its claim goes stale and the message is taken in by the next read", async () => {
    const m = inboxMessage({ subject: `${STAMP} crashed worker` });
    await pool().query("INSERT INTO hd_m365_messages (mailbox_id, message_id, state, attempts, claimed_at) VALUES ($1, $2, 'working', 1, now())", [helpId, m.id]);
    await poll();
    assert.equal((await ticketFor(`${STAMP} crashed worker`)).length, 0, "another worker still holds it");
    await pool().query("UPDATE hd_m365_messages SET claimed_at = now() - interval '11 minutes' WHERE mailbox_id = $1 AND message_id = $2", [helpId, m.id]);
    await poll();
    assert.equal((await ticketFor(`${STAMP} crashed worker`)).length, 1);
    assert.deepEqual([(await seen(m.id)).state, (await seen(m.id)).attempts], ["done", 2]);
  });
});

// --- Aliases ----------------------------------------------------------------------------

describe("several help addresses on one mailbox", () => {
  test("an alias is linked to the mailbox, and mail is routed by the address it was sent to", async () => {
    const link = await call(linkRoute.PUT, req(`${API}/addresses/${boxBilling.id}`, U.manager, { m365_mailbox_id: helpId }, "PUT"), { id: String(boxBilling.id) });
    assert.equal(link.status, 200);
    assert.deepEqual([link.body.link.m365_address, link.body.link.send_via], [HELP, false]);
    assert.deepEqual(link.body.view.mailboxes.find((m: { id: number }) => m.id === helpId).addresses.map((a: { address: string }) => a.address), [HELP, BILLING]);
    assert.deepEqual((await audits("helpdesk.m365.address_changed")).at(-1)!.details, { address: BILLING, mailbox: HELP, was: null, send_via: false });

    // Sent to the alias: Graph's typed recipient shows the mailbox's main address, the To line keeps the alias.
    inboxMessage({ subject: `${STAMP} to the alias`, to: [{ name: "Acme Help", address: HELP }], headerTo: `Acme Billing <${BILLING}>` });
    // Sent to the main address.
    inboxMessage({ subject: `${STAMP} to the main address` });
    // On Bcc: nothing names one of ours.
    inboxMessage({ subject: `${STAMP} on bcc`, to: [], headerTo: "undisclosed-recipients:;" });
    // Both named: the first one written.
    inboxMessage({ subject: `${STAMP} both`, to: [{ name: "", address: BILLING }, { name: "", address: HELP }] });
    await poll();
    const of = async (s: string) => (await ticketFor(`${STAMP} ${s}`))[0];
    assert.deepEqual([(await of("to the alias")).mailbox_id, (await of("to the alias")).team_id], [boxBilling.id, teamB]);
    assert.deepEqual([(await of("to the main address")).mailbox_id, (await of("to the main address")).team_id], [boxHelp.id, teamA]);
    assert.equal((await of("on bcc")).mailbox_id, boxHelp.id, "the mailbox's own address, not the workspace default");
    assert.equal((await of("both")).mailbox_id, boxBilling.id);
    // A message in the second mailbox never lands on the first one's addresses.
    inboxMessage({ subject: `${STAMP} for sales`, to: [], headerTo: "undisclosed-recipients:;" }, SALES);
    const salesId = (await pool().query("SELECT id FROM hd_m365_mailboxes WHERE address = $1", [SALES])).rows[0].id;
    await poll(salesId);
    assert.equal((await of("for sales")).mailbox_id, boxSales.id);
  });

  test("the link's rules: a help address that is gone, a mailbox that is not connected, unlinking", async () => {
    assert.equal((await call(linkRoute.PUT, req(`${API}/addresses/999999999`, U.manager, { m365_mailbox_id: helpId }, "PUT"), { id: "999999999" })).status, 404);
    assert.equal((await call(linkRoute.PUT, req(`${API}/addresses/${boxBilling.id}`, U.manager, { m365_mailbox_id: 999999 }, "PUT"), { id: String(boxBilling.id) })).status, 409);
    assert.equal((await call(linkRoute.PUT, req(`${API}/addresses/${boxBilling.id}`, U.manager, { m365_mailbox_id: "x" }, "PUT"), { id: String(boxBilling.id) })).status, 400);
    const off = await call(linkRoute.PUT, req(`${API}/addresses/${boxBilling.id}`, U.manager, { m365_mailbox_id: null }, "PUT"), { id: String(boxBilling.id) });
    assert.deepEqual([off.status, off.body.link], [200, null]);
    assert.equal((await m365State.m365State()).linked.has(boxBilling.id), false);
    await m365.setM365AddressLink(boxBilling.id, { m365_mailbox_id: helpId }, by());
    assert.equal((await m365State.m365State()).linked.has(boxBilling.id), true);
  });
});

// --- The pipeline's rules, through this path ------------------------------------------------

describe("who may add to a ticket (every existing rule, unchanged)", () => {
  let ticket: { id: number; number: number; reply_token: string | null };
  const replies = async (id: number) => (await pool().query("SELECT body, kind, author_id, author_name FROM hd_messages WHERE ticket_id = $1 AND via <> 'system' ORDER BY id", [id])).rows;
  const fromReq = () => ({ name: "Daniel", address: U.req.email });

  test("a verified account opens a ticket as itself; an unverified or failing one is mail from outside", async () => {
    inboxMessage({ subject: `${STAMP} verified account`, from: fromReq() });
    inboxMessage({ subject: `${STAMP} failing account`, from: fromReq(), fromDomainResults: failResults("example.test") });
    inboxMessage({ subject: `${STAMP} no verdict account`, from: fromReq(), fromDomainResults: "", authAs: [] });
    // Exchange failed it; the sender's own header claims a pass.
    inboxMessage({ subject: `${STAMP} forged verdict`, from: fromReq(), fromDomainResults: failResults("example.test"), senderHeaders: [["Authentication-Results", `mx.example.test; ${passResults("example.test")}`]] });
    // A colleague, from inside the organisation.
    inboxMessage({ subject: `${STAMP} internal colleague`, from: fromReq(), fromDomainResults: "dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=example.test;", authAs: ["Internal"] });
    // The same stamp planted on mail from outside.
    inboxMessage({ subject: `${STAMP} planted internal`, from: fromReq(), fromDomainResults: failResults("example.test"), authAs: ["Internal"] });
    await poll();
    const of = async (s: string) => (await ticketFor(`${STAMP} ${s}`))[0];
    assert.equal((await of("verified account")).requester_id, U.req.id);
    assert.equal((await of("internal colleague")).requester_id, U.req.id);
    for (const s of ["failing account", "no verdict account", "forged verdict", "planted internal"]) assert.equal((await of(s)).requester_id, null, s);
    const note = async (s: string) => (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id", [(await of(s)).id])).rows.map((r) => r.body).join("\n");
    assert.match(await note("failing account"), /failed the sender check \(.*DMARC fail.*\)/);
    assert.match(await note("no verdict account"), /reported no SPF, DKIM or DMARC result/);
    assert.match(await note("forged verdict"), /failed the sender check/);
    ticket = (await of("verified account")) as never;
  });

  test("the requester's reply is added (plus tag, subject reference or In-Reply-To); a failing copy of it is not", async () => {
    const token = await email.ensureReplyToken(ticket.id);
    assert.ok(token);
    const ref = email.threadRef(ticket.number, token!);
    // By the reply address, as a mail client's Reply does.
    inboxMessage({ subject: `Re: ${STAMP} verified account`, from: fromReq(), to: [{ name: "", address: HELP }], headerTo: `help+hd-${token}@${DOMAIN}`, body: { contentType: "text", content: "Reply by plus tag.\n\nOn Friday the desk wrote:\n> earlier text" } });
    // By the subject reference alone.
    inboxMessage({ subject: `RE: ${STAMP} verified account ${ref}`, from: fromReq(), body: { contentType: "text", content: "Reply by subject." } });
    // By the thread headers alone (Exchange keeps In-Reply-To).
    inboxMessage({ subject: `Re: something else ${STAMP}`, from: fromReq(), senderHeaders: [["In-Reply-To", `<hd.${token}.root@${DOMAIN}>`]], body: { contentType: "text", content: "Reply by thread header." } });
    // The same token on mail that failed the check: never into the ticket.
    inboxMessage({ subject: `Re: ${STAMP} spoofed reply ${ref}`, from: fromReq(), fromDomainResults: failResults("example.test"), body: { contentType: "text", content: "I am totally Daniel." } });
    // And from someone who is not on the ticket: a ticket of their own.
    inboxMessage({ subject: `Re: ${STAMP} a stranger's reply ${ref}`, from: { name: "Mallory", address: "mallory@elsewhere.example" }, body: { contentType: "text", content: "Let me in." } });
    await poll();
    const got = (await replies(ticket.id)).map((r) => r.body);
    assert.deepEqual(got.slice(1), ["Reply by plus tag.", "Reply by subject.", "Reply by thread header."]);
    assert.equal((await replies(ticket.id)).at(-1)!.author_id, U.req.id);
    assert.equal((await ticketFor(`${STAMP} spoofed reply`)).length, 1, "a new ticket, outside the workspace");
    assert.equal((await ticketFor(`${STAMP} spoofed reply`))[0].requester_id, null);
    assert.equal((await ticketFor(`${STAMP} a stranger's reply`)).length, 1);
  });

  test("an agent's reply is added as the agent; someone else's account cannot", async () => {
    const token = (await email.ensureReplyToken(ticket.id))!;
    inboxMessage({ subject: `Re: ${STAMP} verified account ${email.threadRef(ticket.number, token)}`, from: { name: "Ana", address: U.agent.email }, body: { contentType: "text", content: "Agent here, by email." } });
    inboxMessage({ subject: `Re: ${STAMP} outsider account ${email.threadRef(ticket.number, token)}`, from: { name: "Noor", address: U.outsider.email }, body: { contentType: "text", content: "Not my ticket." } });
    await poll();
    const last = (await replies(ticket.id)).at(-1)!;
    assert.deepEqual([last.body, last.author_id], ["Agent here, by email.", U.agent.id]);
    assert.equal((await ticketFor(`${STAMP} outsider account`)).length, 1, "their own ticket instead");
  });

  test("loops, auto-replies and duplicates are dropped, and still marked read", async () => {
    const mb = fake.mailboxes.get(HELP)!;
    const dropped = (await row()).dropped;
    // The desk's own mail coming back (a mailbox that receives its own outbound mail).
    const own = inboxMessage({ subject: `${STAMP} our own notice`, from: { name: "Acme Help", address: HELP }, senderHeaders: [["X-CompassDocs-Helpdesk", "1"], ["Auto-Submitted", "auto-generated"]] });
    // From one of our own addresses, carrying a Message-ID of ours in its thread headers.
    const loop = inboxMessage({ subject: `${STAMP} forward loop`, from: { name: "Acme Billing", address: BILLING }, senderHeaders: [["References", `<hd.abcdefgh12345678.root@${DOMAIN}>`]] });
    // An out-of-office.
    const oof = inboxMessage({ subject: `${STAMP} Automatic reply: away`, senderHeaders: [["Auto-Submitted", "auto-replied"], ["X-Auto-Response-Suppress", "All"]] });
    // A mailing list.
    const list = inboxMessage({ subject: `${STAMP} newsletter`, senderHeaders: [["List-Id", "<news.vendor.example>"], ["List-Unsubscribe", "<mailto:leave@vendor.example>"]] });
    // A bounce.
    const bounce = inboxMessage({ subject: `${STAMP} Undeliverable`, from: { name: "Mail Delivery", address: "postmaster@customer.example" } });
    await poll();
    for (const [m, outcome] of [[own, "ignored_loop"], [loop, "ignored_loop"], [oof, "ignored_auto"], [list, "ignored_auto"], [bounce, "ignored_auto"]] as const) {
      assert.deepEqual([(await seen(m.id)).outcome, (await seen(m.id)).filed, mb.messages.get(m.id)!.isRead], [outcome, true, true], m.subject);
      assert.equal((await ticketFor(m.subject)).length, 0, m.subject);
    }
    assert.equal((await row()).dropped, dropped + 5);
    assert.ok((await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND details->>'reason' = 'own_address_loop' AND target_label = $1", [BILLING])).rowCount, "the loop was audited by the pipeline");
  });

  test("outside senders off: mail from nobody we know opens nothing, is audited, and is still marked read", async () => {
    await settingsLib.saveHelpdeskSettings({ outside_senders: false }, { syncMailboxes: false });
    const stranger = inboxMessage({ subject: `${STAMP} from a stranger`, from: { name: "Sam", address: `sam-${STAMP}@elsewhere.example` } });
    const known = inboxMessage({ subject: `${STAMP} from an account`, from: { name: "Daniel", address: U.req.email } });
    const unverified = inboxMessage({ subject: `${STAMP} unverified account`, from: { name: "Daniel", address: U.req.email }, fromDomainResults: failResults("example.test") });
    await poll();
    assert.equal((await ticketFor(`${STAMP} from a stranger`)).length, 0);
    assert.equal((await ticketFor(`${STAMP} unverified account`)).length, 0);
    assert.equal((await ticketFor(`${STAMP} from an account`))[0].requester_id, U.req.id);
    for (const m of [stranger, unverified]) assert.deepEqual([(await seen(m.id)).outcome, fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead], ["rejected_outside_sender", true]);
    assert.equal((await seen(known.id)).outcome, "created");
    const reasons = (await pool().query("SELECT details->>'reason' AS r FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = ANY($1)", [[`sam-${STAMP}@elsewhere.example`, U.req.email]])).rows.map((x) => x.r).sort();
    assert.deepEqual(reasons, ["outside_sender", "unverified_sender"]);
    await settingsLib.saveHelpdeskSettings({ outside_senders: true }, { syncMailboxes: false });
  });

  test("'Trust sender addresses without SPF or DKIM results' applies to mail with no verdict, never to a failing one", async () => {
    await inbound.saveInboundAuthSettings({ trust_unverified_senders: true });
    inboxMessage({ subject: `${STAMP} trusted without results`, from: fromReq(), fromDomainResults: "", authAs: [] });
    inboxMessage({ subject: `${STAMP} still failing`, from: fromReq(), fromDomainResults: failResults("example.test") });
    await poll();
    assert.equal((await ticketFor(`${STAMP} trusted without results`))[0].requester_id, U.req.id);
    assert.equal((await ticketFor(`${STAMP} still failing`))[0].requester_id, null);
    await inbound.saveInboundAuthSettings({ trust_unverified_senders: false });
  });

  test("the per-sender rate limit defers a message without using up its tries", async () => {
    inbound.resetInboundRateLimitsForTests();
    const from = { name: "Burst", address: `burst-${STAMP}@customer.example` };
    const ids: string[] = [];
    for (let i = 0; i < inbound.INBOUND_LIMITS.perSender + 2; i++) ids.push(inboxMessage({ subject: `${STAMP} burst ${i}`, from }).id);
    await poll();
    const states = await Promise.all(ids.map((id) => seen(id)));
    assert.equal(states.filter((s) => s.state === "done").length, inbound.INBOUND_LIMITS.perSender);
    const late = states.filter((s) => s.state === "failed");
    assert.equal(late.length, 2);
    for (const s of late) assert.deepEqual([s.attempts, s.filed], [0, false]);
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(ids.at(-1)!)!.isRead, false, "left unread until it is taken in");
    // The window passes: the next read takes them in.
    inbound.resetInboundRateLimitsForTests();
    await poll();
    assert.equal((await Promise.all(ids.map((id) => seen(id)))).filter((s) => s.state === "done").length, ids.length);
    assert.equal((await ticketFor(`${STAMP} burst ${ids.length - 1}`)).length, 1);
    inbound.resetInboundRateLimitsForTests();
  });
});

// --- Attachments ------------------------------------------------------------------------

describe("attachments", () => {
  test("allowed files are stored; an oversized one is never fetched; other kinds are listed as not added", async () => {
    const saved: { filename: string; mime: string; bytes: number }[] = [];
    inbound.setInboundAttachmentStoreForTests({
      save: async (i) => {
        saved.push({ filename: i.filename, mime: i.mime, bytes: i.buf.length });
        return { id: 900000 + saved.length, filename: i.filename, mime: i.mime, size: i.buf.length } as never;
      },
      bind: async () => [],
    });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(6000, 0x20)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), Buffer.alloc(5000)]);
    const m = inboxMessage({
      subject: `${STAMP} with files`,
      body: { contentType: "html", content: '<p>See attached.</p><img src="cid:logo">' },
      attachments: [
        { id: "a1", name: "invoice.pdf", contentType: "application/pdf", data: pdf },
        { id: "a2", name: "../../etc/passwd\u0000.pdf", contentType: "application/pdf", data: Buffer.from("<html>not a pdf</html>") },
        { id: "a3", name: "run.exe", contentType: "application/octet-stream", data: Buffer.from("MZ") },
        { id: "a4", name: "huge.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-"), size: 80 * 1024 * 1024 },
        { id: "a5", name: "logo.png", contentType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), isInline: true },
        { id: "a6", name: "screenshot.png", contentType: "image/png", data: png, isInline: true },
        { id: "a7", name: "Fwd: the original", contentType: "message/rfc822", data: Buffer.from("x"), odataType: "#microsoft.graph.itemAttachment" },
      ],
    });
    await poll();
    inbound.setInboundAttachmentStoreForTests(null);
    const [t] = await ticketFor(`${STAMP} with files`);
    assert.ok(t);
    assert.deepEqual(saved.map((s) => s.filename).sort(), ["invoice.pdf", "screenshot.png"]);
    assert.equal(fake.calls(`/attachments/a4/$value`).length, 0, "an 80 MB file is not downloaded to be refused");
    assert.equal(fake.calls(`/attachments/a7/$value`).length, 0);
    const note = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id", [t.id])).rows.map((r) => r.body).join("\n");
    assert.match(note, /4 attachments were not added/);
    assert.match(note, /huge\.pdf \(larger than 10 MB\)/);
    assert.match(note, /run\.exe \(file type not allowed\)/);
    assert.match(note, /the content is not a PDF file/);
    assert.match(note, /the original\.item \(file type not allowed\)/);
    assert.doesNotMatch(note, /\.\.\/|\u0000/);
    assert.equal((await seen(m.id)).outcome, "created");
  });
});

// --- After intake: mark read or move; failures -----------------------------------------------

describe("after a message is taken in", () => {
  test("'Move to a folder': the folder is made once, messages leave the Inbox, dropped ones too", async () => {
    const res = await call(rootRoute.PATCH, req(API, U.manager, { after: "move", folder: " Processed " }, "PATCH"));
    assert.deepEqual([res.status, res.body.changed], [200, ["after"]]);
    assert.deepEqual((await audits("helpdesk.m365.settings_changed")).at(-1)!.details.changed, ["after"]);
    const mb = fake.mailboxes.get(HELP)!;
    const a = inboxMessage({ subject: `${STAMP} moved one` });
    const b = inboxMessage({ subject: `${STAMP} Automatic reply: moved too`, senderHeaders: [["Auto-Submitted", "auto-replied"]] });
    await poll();
    assert.deepEqual([...mb.folders.values()], ["Processed"]);
    const folder = [...mb.folders.keys()][0];
    for (const m of [a, b]) assert.deepEqual([mb.messages.get(m.id)!.folder, mb.messages.get(m.id)!.isRead, (await seen(m.id)).filed], [folder, true, true]);
    assert.equal((await row()).processed_folder_id, folder);
    // The next ones reuse it; a folder someone deleted is made again.
    const c = inboxMessage({ subject: `${STAMP} moved two` });
    await poll();
    assert.equal(mb.folders.size, 1);
    assert.equal(mb.messages.get(c.id)!.folder, folder);
    mb.folders.clear();
    const d = inboxMessage({ subject: `${STAMP} moved three` });
    await poll();
    assert.deepEqual([...mb.folders.values()], ["Processed"]);
    assert.equal(mb.messages.get(d.id)!.folder, [...mb.folders.keys()][0]);
    // The moves come back in the delta as removals and open nothing.
    await poll();
    assert.equal((await ticketFor(`${STAMP} moved three`)).length, 1);
    // Rules for the options.
    assert.equal((await call(rootRoute.PATCH, req(API, U.manager, { after: "delete" }, "PATCH"))).status, 400);
    assert.equal((await call(rootRoute.PATCH, req(API, U.manager, { folder: " / " }, "PATCH"))).status, 400);
    assert.equal((await call(rootRoute.PATCH, req(API, U.manager, { poll_minutes: 0 }, "PATCH"))).status, 400);
    assert.equal((await call(rootRoute.PATCH, req(API, U.manager, { poll_minutes: 61 }, "PATCH"))).status, 400);
    assert.deepEqual((await call(rootRoute.PATCH, req(API, U.manager, { after: "read" }, "PATCH"))).body.changed, ["after"]);
  });

  test("marking fails (Microsoft says no): the ticket exists, the mailbox says what is wrong, and it is finished on a later read", async () => {
    fake.fail.patch = 403;
    const m = inboxMessage({ subject: `${STAMP} could not be marked` });
    const r = await poll();
    assert.equal(r.ok, false);
    assert.match(r.error!, /New mail was taken in, but could not be marked as read:/);
    assert.equal((await ticketFor(`${STAMP} could not be marked`)).length, 1);
    assert.deepEqual([(await seen(m.id)).state, (await seen(m.id)).filed], ["done", false]);
    fake.fail = {};
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await seen(m.id)).filed, true);
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, true);
    assert.equal((await ticketFor(`${STAMP} could not be marked`)).length, 1);
  });

  test("a message that cannot be read is left alone and retried, five times, then counted, shown and audited", async () => {
    fake.fail.message = 500;
    const m = inboxMessage({ subject: `${STAMP} unreadable` });
    for (let i = 1; i <= shared.M365_MAIL_LIMITS.attempts; i++) {
      await poll();
      assert.deepEqual([(await seen(m.id)).state, (await seen(m.id)).attempts], ["failed", i]);
    }
    const r = await row();
    assert.equal(r.failed, 1);
    assert.match(r.last_error, /^1 message could not be taken in after 5 tries\. It is still in the Inbox, unread\./);
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, false, "left exactly as it was");
    const a = (await audits("helpdesk.m365.intake_failed")).at(-1)!;
    assert.deepEqual([a.details.address, a.details.attempts, a.actor_name], [HELP, 5, "Microsoft 365 mail"]);
    assert.match(a.details.error, /had a problem \(error 500\)/);
    // No sixth try, however often the mailbox is read.
    const gets = fake.calls(`/messages/${encodeURIComponent(m.id)}`).length;
    await poll();
    assert.equal(fake.calls(`/messages/${encodeURIComponent(m.id)}`).length, gets);
    assert.equal((await ticketFor(`${STAMP} unreadable`)).length, 0);
    fake.fail = {};
    await pool().query("DELETE FROM hd_m365_messages WHERE mailbox_id = $1 AND message_id = $2", [helpId, m.id]);
    fake.removeMessage(HELP, m.id);
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await row()).last_error, "");
  });

  test("a message a person deleted before the desk read it is simply gone", async () => {
    const m = inboxMessage({ subject: `${STAMP} deleted in Outlook` });
    const sub = [...fake.subscriptions.values()].find((s) => s.mailbox === HELP)!;
    fake.mailboxes.get(HELP)!.messages.delete(m.id);
    const a = await m365.handleM365Notification(new Request(`http://localhost/x`, { method: "POST", body: JSON.stringify({ value: [{ subscriptionId: sub.id, clientState: sub.clientState, changeType: "created", resourceData: { id: m.id } }] }) }), (await cfg()).notify_key);
    await a.work!();
    assert.deepEqual([(await seen(m.id)).outcome, (await seen(m.id)).filed], ["gone", true]);
  });
});

// --- Subscriptions in the background ---------------------------------------------------------

describe("subscriptions are kept alive by the scheduler", () => {
  const sub = () => [...fake.subscriptions.values()].find((s) => s.mailbox === HELP);

  test("renewed a day before it ends; left alone before that", async () => {
    const id = sub()!.id;
    const patches = () => fake.calls(`PATCH /graph/v1.0/subscriptions/${id}`).length;
    const before = patches();
    await m365.m365MailSweep();
    assert.equal(patches(), before, "two days left: nothing to do");
    await pool().query("UPDATE hd_m365_mailboxes SET sub_expires_at = now() + interval '5 hours' WHERE id = $1", [helpId]);
    await m365.m365MailSweep();
    assert.equal(patches(), before + 1);
    assert.equal(sub()!.id, id, "the same subscription");
    assert.ok(Date.parse((await row()).sub_expires_at) - Date.now() > 40 * 3_600_000);
  });

  test("gone at Microsoft (404 on renewal): a new one, with a new clientState", async () => {
    const old = sub()!;
    fake.subscriptions.delete(old.id);
    await pool().query("UPDATE hd_m365_mailboxes SET sub_expires_at = now() + interval '5 hours' WHERE id = $1", [helpId]);
    await m365.m365MailSweep();
    assert.ok(sub() && sub()!.id !== old.id && sub()!.clientState !== old.clientState);
    assert.equal((await row()).sub_id, sub()!.id);
  });

  test("two instances at the same tick make one subscription, and a renewal Microsoft is too busy for keeps the one there is", async () => {
    fake.subscriptions.delete(sub()!.id);
    await pool().query("UPDATE hd_m365_mailboxes SET sub_expires_at = now() + interval '5 hours', last_poll_at = now(), poll_due = false");
    const posts = fake.calls("POST /graph/v1.0/subscriptions").length;
    await Promise.all([m365.m365MailSweep(), m365.m365MailSweep(), m365.m365MailSweep()]);
    assert.equal([...fake.subscriptions.values()].filter((s) => s.mailbox === HELP).length, 1, "one subscription at Microsoft");
    assert.equal(fake.calls("POST /graph/v1.0/subscriptions").length - posts, 1, "one instance asked Microsoft for it");
    const r = await row();
    assert.deepEqual([r.sub_id, r.sub_state], [sub()!.id, sub()!.clientState], "and the row holds its id and its clientState");
    // Renewal while Microsoft answers 503: nothing is thrown away.
    fake.fail.renew = 503;
    await pool().query("UPDATE hd_m365_mailboxes SET sub_expires_at = now() + interval '5 hours' WHERE id = $1", [helpId]);
    await m365.m365MailSweep();
    fake.fail = {};
    assert.deepEqual([(await row()).sub_id, (await row()).sub_error], [sub()!.id, ""]);
    await m365.m365MailSweep();
    assert.ok(Date.parse((await row()).sub_expires_at) - Date.now() > 40 * 3_600_000, "renewed at the next tick");
  });

  test("lifecycle notifications: removed, reauthorizationRequired, missed", async () => {
    // subscriptionRemoved: the row forgets it, a read is asked for, the next tick makes a new one.
    const first = sub()!.id;
    assert.equal(await fake.lifecycle(HELP, "subscriptionRemoved"), 202);
    await settled();
    assert.deepEqual([(await row()).sub_id, (await row()).poll_due], ["", true]);
    await m365.m365MailSweep();
    assert.ok(sub() && sub()!.id !== first);
    // reauthorizationRequired: renewed at once, with one PATCH.
    const id = sub()!.id;
    const patches = fake.calls(`PATCH /graph/v1.0/subscriptions/${id}`).length;
    assert.equal(await fake.lifecycle(HELP, "reauthorizationRequired"), 202);
    await settled();
    assert.equal(fake.calls(`PATCH /graph/v1.0/subscriptions/${id}`).length, patches + 1);
    // missed: a read at the next tick, which finds what the notification never brought.
    const m = inboxMessage({ subject: `${STAMP} missed notification` });
    await pool().query("UPDATE hd_m365_mailboxes SET poll_due = false, last_poll_at = now() WHERE id = $1", [helpId]);
    await m365.m365MailSweep();
    assert.equal(await seen(m.id), undefined, "the safety net is not due yet");
    assert.equal(await fake.lifecycle(HELP, "missed"), 202);
    await settled();
    assert.equal((await row()).poll_due, true);
    await m365.m365MailSweep();
    assert.equal((await seen(m.id)).outcome, "created");
    // A lifecycle event without the clientState does nothing.
    const a = await m365.handleM365Notification(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ value: [{ subscriptionId: sub()!.id, clientState: "nope", lifecycleEvent: "subscriptionRemoved" }] }) }), (await cfg()).notify_key);
    assert.deepEqual(a, { status: 202 });
    assert.equal((await row()).sub_id, sub()!.id);
  });

  test("the timer: every poll_minutes without notifications, every 15 minutes as the safety net with them", async () => {
    const delta = () => fake.calls("/messages/delta").length;
    await pool().query("UPDATE hd_m365_mailboxes SET poll_due = false, last_poll_at = now() - interval '3 minutes'");
    let n = delta();
    await m365.m365MailSweep();
    assert.equal(delta(), n, "notifications work: three minutes is not due");
    await pool().query("UPDATE hd_m365_mailboxes SET last_poll_at = now() - interval '16 minutes'");
    await m365.m365MailSweep();
    assert.equal(delta(), n + 2, "both mailboxes read by the safety net");
    // A read claimed by another instance is left to it.
    await pool().query("UPDATE hd_m365_mailboxes SET last_poll_at = now() - interval '16 minutes', claimed_until = now() + interval '4 minutes'");
    n = delta();
    assert.deepEqual(await m365.m365MailSweep(), { polled: 0 });
    assert.equal(delta(), n);
    assert.deepEqual(await poll(), { ok: false, busy: true });
    await pool().query("UPDATE hd_m365_mailboxes SET claimed_until = NULL, last_poll_at = now()");
  });

  test("Microsoft refuses a subscription: recorded, audited once, the timer takes over, and it is tried again later", async () => {
    await call(rootRoute.PATCH, req(API, U.manager, { poll_minutes: 3 }, "PATCH"));
    fake.subscriptions.delete(sub()!.id);
    fake.fail.subscriptions = 403;
    await pool().query("UPDATE hd_m365_mailboxes SET sub_expires_at = now() + interval '1 hour', last_poll_at = now() - interval '4 minutes' WHERE id = $1", [helpId]);
    const before = (await audits("helpdesk.m365.subscription_failed")).length;
    const polls = fake.calls(`${encodeURIComponent(HELP)}/mailFolders/inbox/messages/delta`).length;
    await m365.m365MailSweep();
    const r = await row();
    assert.equal(r.sub_id, "");
    assert.match(r.sub_error, /did not let the app turn on notifications for this mailbox/);
    const v = (await m365.m365MailView()).mailboxes.find((m) => m.id === helpId)!;
    assert.equal(v.mode, "timer_refused");
    assert.match(shared.modeSentence(v.mode, 3, ""), /refused notifications for this mailbox, so the desk checks every 3 minutes/);
    assert.equal(fake.calls(`${encodeURIComponent(HELP)}/mailFolders/inbox/messages/delta`).length, polls + 1, "four minutes is due on the timer");
    const a = await audits("helpdesk.m365.subscription_failed");
    assert.equal(a.length, before + 1);
    assert.deepEqual([a.at(-1)!.details.address, a.at(-1)!.details.fallback], [HELP, "timer"]);
    // The next ticks do not hammer Microsoft or the audit log.
    const posts = fake.calls("POST /graph/v1.0/subscriptions").length;
    await m365.m365MailSweep();
    await m365.m365MailSweep();
    assert.equal(fake.calls("POST /graph/v1.0/subscriptions").length, posts);
    assert.equal((await audits("helpdesk.m365.subscription_failed")).length, before + 1);
    // Fifteen minutes on, Microsoft says yes.
    fake.fail = {};
    await pool().query("UPDATE hd_m365_mailboxes SET sub_error_at = now() - interval '16 minutes' WHERE id = $1", [helpId]);
    await m365.m365MailSweep();
    assert.deepEqual([(await row()).sub_error, (await row()).sub_id], ["", sub()!.id]);
  });

  test("Microsoft cannot reach the desk, or notifications are off: the timer alone, and the page says why", async () => {
    // The handshake fails (nothing answers at the address Microsoft was given).
    fake.subscriptions.clear();
    await pool().query("UPDATE hd_m365_mailboxes SET sub_id = '', sub_expires_at = NULL, sub_error = '', sub_error_at = NULL");
    const good = (await cfg()).notify_origin;
    await m365.saveM365Settings({ notify_origin: "http://127.0.0.1:9" }, by());
    await m365.m365MailSweep();
    assert.equal((await row()).sub_error, "Microsoft could not reach this desk's notification address, or it did not answer in time.");
    // An address Microsoft could never reach: no attempt at all.
    await pool().query("UPDATE hd_m365_mailboxes SET sub_error = '', sub_error_at = NULL");
    delete process.env.COMPASSDOCS_M365_MAIL_TEST_BASE;
    assert.equal(m365.notifyBase("http://127.0.0.1:9"), null);
    process.env.COMPASSDOCS_M365_MAIL_TEST_BASE = fake.base;
    const c = await cfg();
    await setSetting(KEY, JSON.stringify({ ...JSON.parse((await pool().query("SELECT value FROM settings WHERE key = $1", [KEY])).rows[0].value), notify_origin: "http://desk.internal:3000" }));
    const posts = fake.calls("POST /graph/v1.0/subscriptions").length;
    await m365.m365MailSweep();
    assert.equal(fake.calls("POST /graph/v1.0/subscriptions").length, posts);
    const v = await m365.m365MailView();
    assert.deepEqual([v.notify_url_ok, v.mailboxes[0].mode], [false, "timer_no_address"]);
    assert.match(shared.modeSentence("timer_no_address", 3, "http://desk.internal:3000"), /can't reach this desk at http:\/\/desk\.internal:3000 \(it needs a public https address\)/);
    assert.equal(c.notify_key, (await cfg()).notify_key);
    // Back on a reachable address; then the admin turns notifications off: the subscriptions are deleted at Microsoft.
    // An admin who has the desk open at an address Microsoft can reach says "use this one": the old subscriptions go, new ones are made.
    await assert.rejects(m365.saveM365Settings({ notify_origin: "http://desk.internal:3000" }, by()), /can't reach that address\. It needs a public https address/);
    const here = await call(rootRoute.PATCH, req(API, U.manager, { notify_here: true, notify_origin: "https://attacker.example" }, "PATCH"));
    assert.deepEqual(here.body.changed, ["notify_origin"]);
    assert.notEqual(here.body.view.notify_origin, "https://attacker.example", "the address the request came in on, never a typed one");
    assert.ok(here.body.view.notify_url_ok);
    await m365.saveM365Settings({ notify_origin: good }, by());
    await m365.m365MailSweep();
    assert.equal(fake.subscriptions.size, 2);
    const off = await call(rootRoute.PATCH, req(API, U.manager, { notifications: false, poll_minutes: 2 }, "PATCH"));
    assert.deepEqual(off.body.changed, ["notifications", "poll_minutes"]);
    assert.equal(fake.subscriptions.size, 0);
    assert.equal(off.body.view.mailboxes[0].mode, "timer_off");
    await m365.m365MailSweep();
    assert.equal(fake.subscriptions.size, 0);
    await call(rootRoute.PATCH, req(API, U.manager, { notifications: true }, "PATCH"));
    await m365.m365MailSweep();
    assert.equal(fake.subscriptions.size, 2);
  });

  test("'Check now' reads at once and answers in words", async () => {
    const m = inboxMessage({ subject: `${STAMP} check now` });
    await pool().query("UPDATE hd_m365_mailboxes SET poll_due = false, last_poll_at = now()");
    const r = await call(checkRoute.POST, req(`${API}/mailboxes/${helpId}/check`, U.manager, {}), { id: String(helpId) });
    assert.deepEqual([r.status, r.body.ok, r.body.error], [200, true, undefined]);
    assert.equal((await seen(m.id)).outcome, "created");
    assert.equal(r.body.view.mailboxes.find((x: { id: number }) => x.id === helpId).last_error, "");
    assert.equal((await call(checkRoute.POST, req(`${API}/mailboxes/424242/check`, U.manager, {}), { id: "424242" })).status, 404);
  });
});

// --- Sending through Graph ---------------------------------------------------------------

describe("send replies through Microsoft 365", () => {
  let ticketId = 0;
  let number = 0;
  const reply = async (text: string) => {
    smtp.length = 0;
    await messages.addMessage(ticketId, { kind: "public", body: text, author: { id: U.agent.id, name: U.agent.name, email: U.agent.email }, via: "desk" }, { actorId: U.agent.id, actorName: U.agent.name });
    await new Promise((r) => setTimeout(r, 500));
  };
  const sentMime = () => fake.mailboxes.get(HELP)!.sent.map((b) => b.toString("utf8"));

  test("not chosen: SMTP as before, now with the reply address although the inbound webhook is off", async () => {
    const { createTicket } = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets"); // eslint-disable-line @typescript-eslint/no-require-imports
    const t = await createTicket({ subject: `${STAMP} sending`, body: "x", requester: { id: null, name: "Cara Customer", email: `cara-${STAMP}@customer.example` }, via: "email", source: "email", team_id: teamA, mailbox_id: boxHelp.id }, {});
    ticketIds.push(t.id);
    ticketId = t.id;
    number = t.number;
    await reply("First answer.");
    assert.equal(sentMime().length, 0);
    const m = smtp.find((x) => x.to === `cara-${STAMP}@customer.example`)!;
    assert.ok(m, "the workspace transport carried it");
    assert.match(m.replyTo!, new RegExp(`^help\\+hd-[a-z0-9]{16}@${DOMAIN.replace(/\./g, "\\.")}$`), "a help address read through Microsoft 365 takes replies");
    assert.match(m.from, /"Acme Help" </);
  });

  test("chosen: the reply leaves through Graph as the mailbox, with everything the thread needs, and not by SMTP", async () => {
    const res = await call(linkRoute.PUT, req(`${API}/addresses/${boxHelp.id}`, U.manager, { m365_mailbox_id: helpId, send_via: true }, "PUT"), { id: String(boxHelp.id) });
    assert.deepEqual([res.status, res.body.link.send_via], [200, true]);
    assert.equal((await m365State.m365State()).sendVia.has(boxHelp.id), true);
    await reply("Sent through Microsoft 365.");
    assert.equal(smtp.filter((x) => x.to === `cara-${STAMP}@customer.example`).length, 0, "not by SMTP");
    const mime = (sentMime()[0] ?? "").replace(/\r\n[ \t]+/g, " "); // unfolded
    assert.ok(mime, "in the mailbox's Sent Items");
    const token = (await pool().query("SELECT reply_token FROM hd_tickets WHERE id = $1", [ticketId])).rows[0].reply_token;
    assert.match(mime, new RegExp(`^From: Acme Help <${HELP.replace(/\./g, "\\.")}>\\r$`, "m"));
    assert.match(mime, new RegExp(`^To: cara-${STAMP}@customer\\.example\\r$`, "m"));
    assert.match(mime, new RegExp(`^Reply-To: help\\+hd-${token}@`, "m"));
    assert.match(mime, new RegExp(`^Subject: .*\\[#${number} ref:${token}\\]`, "m"));
    assert.match(mime, new RegExp(`^Message-ID: <hd\\.${token}\\.`, "m"));
    assert.match(mime, new RegExp(`^In-Reply-To: <hd\\.${token}\\.root@`, "m"));
    assert.match(mime, /^X-Compassdocs-Helpdesk: 1\r$/im);
    assert.match(mime, /^Auto-Submitted: auto-generated\r$/im);
    assert.match(mime, /Sent through Microsoft 365\./);
    const call1 = fake.calls(`POST /graph/v1.0/users/${encodeURIComponent(HELP)}/sendMail 202`);
    assert.equal(call1.length, 1);
    // An agent's own notice (a new ticket for the team) is not sent as the mailbox.
    const { createTicket } = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets"); // eslint-disable-line @typescript-eslint/no-require-imports
    smtp.length = 0;
    const t2 = await createTicket({ subject: `${STAMP} agent notice`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, via: "portal", source: "portal", team_id: teamA, mailbox_id: boxHelp.id }, { actorId: U.req.id, actorName: U.req.name });
    ticketIds.push(t2.id);
    await new Promise((r) => setTimeout(r, 500));
    for (const mm of sentMime().slice(1)) assert.doesNotMatch(mm, new RegExp(`^To: ${U.agent.email.replace(/\./g, "\\.")}`, "m"), "agents' notices stay on the workspace transport");
  });

  test("the reply that comes back threads: Exchange may replace our Message-ID, the reply address and subject still name the ticket", async () => {
    const token = (await pool().query("SELECT reply_token FROM hd_tickets WHERE id = $1", [ticketId])).rows[0].reply_token;
    await m365.setM365AddressLink(boxHelp.id, { m365_mailbox_id: helpId, send_via: true }, by());
    // The customer's client replies to Reply-To; In-Reply-To names a Message-ID Exchange made up.
    inboxMessage({
      subject: `RE: ${STAMP} sending`,
      from: { name: "Cara Customer", address: `cara-${STAMP}@customer.example` },
      to: [{ name: "Acme Help", address: HELP }],
      headerTo: `Acme Help <help+hd-${token}@${DOMAIN}>`,
      senderHeaders: [["In-Reply-To", "<BN8PR12MB0001E1F2@BN8PR12MB0001.namprd12.prod.outlook.com>"]],
      body: { contentType: "text", content: "Thanks, that fixed it." },
    });
    await poll();
    const last = (await pool().query("SELECT body, via FROM hd_messages WHERE ticket_id = $1 AND via <> 'system' ORDER BY id DESC LIMIT 1", [ticketId])).rows[0];
    assert.deepEqual([last.body, last.via], ["Thanks, that fixed it.", "email"]);
  });

  test("Microsoft refuses: the same mail goes out by SMTP from the workspace address; recorded, shown, audited once; cleared by the next that goes through", async () => {
    fake.fail.sendMail = 403;
    const before = (await audits("helpdesk.m365.send_refused")).length;
    const sent = sentMime().length;
    await reply("Refused once.");
    assert.equal(sentMime().length, sent);
    const m = smtp.find((x) => x.to === `cara-${STAMP}@customer.example`)!;
    assert.ok(m, "it still reached the requester");
    assert.doesNotMatch(m.from, new RegExp(HELP), "from the workspace address");
    assert.match(m.from, /"Acme Help" </);
    assert.match(m.replyTo!, /^help\+hd-/);
    const link = (await m365.m365MailView()).links.find((l) => l.mailbox_id === boxHelp.id)!;
    assert.match(link.send_error, /did not let the app send mail as this mailbox/);
    assert.ok(link.send_error_at);
    await reply("Refused twice.");
    const a = await audits("helpdesk.m365.send_refused");
    assert.equal(a.length, before + 1, "once per streak");
    assert.deepEqual([a.at(-1)!.details.address, a.at(-1)!.details.mailbox, a.at(-1)!.details.fallback], [HELP, HELP, "smtp_workspace_address"]);
    fake.fail = {};
    await reply("Through again.");
    assert.equal(sentMime().length, sent + 1);
    assert.equal((await m365.m365MailView()).links.find((l) => l.mailbox_id === boxHelp.id)!.send_error, "");
    // Microsoft busy: SMTP this once, nothing recorded.
    fake.fail.sendMail = 503;
    await reply("While Microsoft was busy.");
    assert.ok(smtp.find((x) => x.to === `cara-${STAMP}@customer.example`));
    assert.equal((await m365.m365MailView()).links.find((l) => l.mailbox_id === boxHelp.id)!.send_error, "");
    fake.fail = {};
  });

  test("it is one more choice of 'Send replies from': a send-from address picked later wins, and choosing Microsoft 365 clears one", async () => {
    const sender = await sendAddresses.createSendAddress({ address: `support@${DOMAIN}`, name: "" }, by());
    await mailboxes.updateMailbox(boxHelp.id, { send_address_id: sender.id }, by());
    assert.equal((await m365.m365MailView()).links.find((l) => l.mailbox_id === boxHelp.id)!.send_via, false, "the picked send-from address is in force");
    const sent = sentMime().length;
    await reply("From the send-from address.");
    assert.equal(sentMime().length, sent);
    assert.match(smtp.find((x) => x.to === `cara-${STAMP}@customer.example`)!.from, new RegExp(`support@${DOMAIN.replace(/\./g, "\\.")}`));
    await m365.setM365AddressLink(boxHelp.id, { m365_mailbox_id: helpId, send_via: true }, by());
    assert.equal((await mailboxes.getMailbox(boxHelp.id))!.send_address_id, null);
    await reply("Through Microsoft 365 again.");
    assert.equal(sentMime().length, sent + 1);
  });

  test("Send test goes the way a reply would", async () => {
    await pool().query("UPDATE users SET email = $2 WHERE id = $1", [U.manager.id, U.manager.email]);
    const sent = sentMime().length;
    const ok = await call(testRoute.POST, req(`http://localhost/api/helpdesk/admin/mailboxes/${boxHelp.id}/test`, U.manager, {}), { id: String(boxHelp.id) });
    assert.deepEqual([ok.status, ok.body.ok, ok.body.from, ok.body.via], [200, true, HELP, "microsoft_365"]);
    assert.equal(sentMime().length, sent + 1);
    assert.match(sentMime().at(-1)!, /This test was sent through Microsoft 365 as/);
    fake.fail.sendMail = 403;
    const no = await call(testRoute.POST, req(`http://localhost/api/helpdesk/admin/mailboxes/${boxHelp.id}/test`, U.manager, {}), { id: String(boxHelp.id) });
    assert.deepEqual([no.body.ok, no.body.via], [false, "microsoft_365"]);
    assert.match(no.body.error, /did not let the app send mail as this mailbox/);
    fake.fail = {};
    // An address that does not send through Microsoft 365 is tested by SMTP, as before.
    const other = await call(testRoute.POST, req(`http://localhost/api/helpdesk/admin/mailboxes/${boxSales.id}/test`, U.manager, {}), { id: String(boxSales.id) });
    assert.deepEqual([other.body.ok, other.body.via], [true, undefined]);
    await m365.setM365AddressLink(boxHelp.id, { m365_mailbox_id: helpId, send_via: true }, by());
  });

  test("a mail too large for Graph's request limit goes by SMTP, and is not a refusal", async () => {
    const big = { to: "a@b.example", from: "x@y.example", subject: "s", text: "t".repeat(m365Send.M365_SEND_MAX_MIME + 10), html: "<p>t</p>", headers: {} };
    const was = (await m365.m365MailView()).links.find((l) => l.mailbox_id === boxHelp.id)!.send_error_at;
    const posts = fake.calls("/sendMail").length;
    assert.equal(await m365Send.sendThroughM365(boxHelp.id, HELP, "Acme Help", big), "refused");
    assert.equal(fake.calls("/sendMail").length, posts, "never offered to Microsoft");
    assert.equal((await m365.m365MailView()).links.find((l) => l.mailbox_id === boxHelp.id)!.send_error_at, was, "nothing new recorded");
  });
});

// --- The one-click setup (enterprise overlay) ----------------------------------------------

const EE_SETUP = path.join(__dirname, "..", "ee", "m365-mail-setup.ts");
describe("the one-click setup", { skip: !fs.existsSync(EE_SETUP) && "the enterprise overlay is not in this checkout" }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setup: any;
  const start = () => call((r: Request) => setup.m365MailSetupHandler("POST", ["start"], r), req("http://localhost/api/ee/m365-mail/setup/start", U.manager, {}));
  const pollSetup = (id: string, who: Person | null = U.manager) => call((r: Request) => setup.m365MailSetupHandler("POST", ["poll"], r), req("http://localhost/api/ee/m365-mail/setup/poll", who, { setup_id: id }));
  const run = async () => {
    const s = await start();
    assert.equal(s.status, 200);
    assert.equal(s.body.user_code, "H7KQ2MZP9");
    assert.deepEqual((await pollSetup(s.body.setup_id)).body, { status: "pending" });
    return pollSetup(s.body.setup_id);
  };
  const live = () => [...fake.apps.values()].filter((a) => a !== app && !a.deleted);

  before(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    setup = require("../ee/m365-mail-setup");
  });

  test("refused while a connection is saved (a second run would leave a second app in Entra)", async () => {
    const s = await start();
    assert.deepEqual([s.status, s.body.error], [409, "Microsoft 365 is already connected. To make a new app registration, remove the connection first."]);
    assert.equal(live().length, 0);
  });

  test("permissions: a session, and the Email settings capability", async () => {
    assert.equal((await call((r: Request) => setup.m365MailSetupHandler("POST", ["start"], r), req("http://localhost/x", null, {}))).status, 401);
    assert.equal((await call((r: Request) => setup.m365MailSetupHandler("POST", ["start"], r), req("http://localhost/x", U.agent, {}))).status, 403);
    assert.equal((await pollSetup("whatever", U.agent)).status, 403);
    assert.equal((await pollSetup("whatever")).status, 410);
  });

  test("removing the connection keeps the mailboxes; a sign-in to another organisation is then refused before anything is created", async () => {
    const del = await call(rootRoute.DELETE, req(API, U.manager, undefined, "DELETE"));
    assert.deepEqual([del.status, del.body.view.connected, del.body.view.orphaned, del.body.view.mailboxes.length], [200, false, true, 2]);
    assert.equal(fake.subscriptions.size, 0, "its subscriptions were deleted at Microsoft");
    assert.deepEqual((await audits("helpdesk.m365.connection_removed")).at(-1)!.details, { tenant: fake.tenantId, client_id: app.appId });
    assert.deepEqual(await m365.m365MailSweep(), { polled: 0 });
    assert.equal((await m365State.m365State()).configured, false);
    fake.deviceTenant = "11111111-aaaa-bbbb-cccc-222222222222";
    const r = await run();
    assert.equal(r.status, 502);
    assert.match(r.body.error, /different Microsoft 365 organisation than the mailboxes connected here belong to, so nothing was created/);
    assert.equal(live().length, 0);
    assert.equal(fake.calls("POST /graph/v1.0/applications").length, 0);
    // The manual form holds the same line.
    const other = fake.addApp({ tenant: fake.deviceTenant });
    const manual = await call(rootRoute.PUT, req(API, U.manager, { tenant: fake.deviceTenant, client_id: other.appId, secret: other.secrets[0] }, "PUT"));
    assert.deepEqual([manual.status, manual.body.code], [409, "tenant_change"]);
    other.deleted = true;
    fake.deviceTenant = fake.tenantId;
  });

  test("a step fails after the app was created: it is removed from Entra again, and nothing is saved", async () => {
    fake.failStep = "servicePrincipals";
    const r = await run();
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Insufficient privileges.* The new app registration was removed from Entra again\./);
    assert.equal(live().length, 0);
    assert.equal(fake.calls(/DELETE \/graph\/v1\.0\/applications\/\S+ 204/).length, 1);
    assert.equal((await cfg()).secret, "");
    // The removal fails too: the admin is told what was left.
    fake.deleteFails = true;
    const left = await run();
    assert.match(left.body.error, /An app registration named "CompassDocs Helpdesk Mail" was left in Entra\. Delete it there before you try again\./);
    for (const a of live()) a.deleted = true;
    fake.failStep = "";
    fake.deleteFails = false;
  });

  test("done: an app with no Graph permission at all, its secret sealed, audited; it can read nothing until the commands are run", async () => {
    fake.signInDelayMs = 2500; // Microsoft is still activating the app at the first try
    const t0 = Date.now();
    const r = await run();
    fake.signInDelayMs = 0;
    assert.equal(r.status, 200);
    const [made] = live();
    assert.ok(Date.now() - t0 >= 2000, "the first sign-in was refused and tried again");
    assert.deepEqual([r.body.status, r.body.tenant, r.body.client_id, r.body.verified], ["done", fake.tenantId, made.appId, true]);
    assert.match(r.body.secret_expires, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!fake.log.includes("! setup asked for Graph permissions"));
    assert.deepEqual([made.roles, made.displayName], [[], "CompassDocs Helpdesk Mail"]);
    assert.ok(!JSON.stringify(r.body).includes(made.secrets[0]));
    const c = await cfg();
    assert.deepEqual([c.client_id, c.secret, c.sp_object_id, c.setup, c.verified, c.secret_expires], [made.appId, made.secrets[0], made.spId, "one_click", true, r.body.secret_expires]);
    const a = (await audits("helpdesk.m365.connection_saved")).at(-1)!;
    assert.deepEqual([a.details.setup, a.details.client_id, a.details.verified, a.details.secret_expires], ["one_click", made.appId, true, r.body.secret_expires]);
    assert.ok(!JSON.stringify(a.details).includes(made.secrets[0]));
    // The new app is in no Exchange scope yet: both mailboxes are back to waiting, and the check says so.
    await pool().query("UPDATE hd_m365_mailboxes SET last_poll_at = NULL");
    await m365.m365MailSweep();
    assert.match((await row()).last_error, /has not let the app read this mailbox yet/);
    const check = await m365.checkM365Access({}, by());
    assert.deepEqual([check.tenant_wide, check.mailboxes.map((m) => m.ok)], [[], [false, false]]);
    made.scope = new Set([HELP, SALES]);
    made.sendScope = new Set([HELP]);
    assert.deepEqual((await m365.checkM365Access({}, by())).mailboxes.map((m) => m.ok), [true, true]);
    app = made;
  });

  test("an app Microsoft has not activated in time is saved all the same (the secret is shown once), and says so", async () => {
    const pending = fake.addApp({ activeAt: Date.now() + 60_000 });
    await m365.removeM365Connection(by());
    const r = await m365.saveM365Connection({ tenant: fake.tenantId, client_id: pending.appId, secret: pending.secrets[0] }, by(), { setup: "one_click", tenantId: fake.tenantId, spObjectId: pending.spId, secretExpires: "2028-11-12", verify: false });
    assert.deepEqual([r.verified, (await cfg()).verified, (await cfg()).sp_object_id], [false, false, pending.spId]);
    await assert.rejects(m365.saveM365Connection({ tenant: "contoso.example", client_id: pending.appId, secret: pending.secrets[0] }, by(), { setup: "one_click", tenantId: fake.tenantId, verify: false }), /must be the ID of the tenant it was created in/);
    // Back to the working app for the rest of the file.
    await m365.removeM365Connection(by());
    await m365.saveM365Connection({ tenant: fake.tenantId, client_id: app.appId, secret: app.secrets[0] }, by());
    assert.equal((await cfg()).notify_origin, bridgeOrigin, "kept across the connection");
  });
});

// --- Permissions --------------------------------------------------------------------------

describe("permissions on every new route", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Handler = (r: Request, ctx: any) => Promise<Response>;
  const routes = (): [string, () => Request, Handler, Record<string, string>][] => [
    ["GET view", () => req(API, null, undefined, "GET"), rootRoute.GET, {}],
    ["PUT connection", () => req(API, null, { tenant: fake.tenantId, client_id: app.appId, secret: "x" }, "PUT"), rootRoute.PUT, {}],
    ["PATCH options", () => req(API, null, { poll_minutes: 5 }, "PATCH"), rootRoute.PATCH, {}],
    ["DELETE connection", () => req(API, null, undefined, "DELETE"), rootRoute.DELETE, {}],
    ["POST check-access", () => req(`${API}/check-access`, null, {}), accessRoute.POST, {}],
    ["POST mailbox", () => req(`${API}/mailboxes`, null, { address: OTHER }), boxesRoute.POST, {}],
    ["DELETE mailbox", () => req(`${API}/mailboxes/${helpId}`, null, undefined, "DELETE"), boxRoute.DELETE, { id: String(helpId) }],
    ["POST check now", () => req(`${API}/mailboxes/${helpId}/check`, null, {}), checkRoute.POST, { id: String(helpId) }],
    ["PUT address link", () => req(`${API}/addresses/${boxHelp.id}`, null, { m365_mailbox_id: null }, "PUT"), linkRoute.PUT, { id: String(boxHelp.id) }],
  ];
  const as = (r: Request, who: Person) => {
    const h = new Headers(r.headers);
    h.set("cookie", `compass_session=${who.session}`);
    return new Request(r.url, { method: r.method, headers: h, body: r.method === "GET" || r.method === "DELETE" ? undefined : r.body, duplex: "half" } as RequestInit);
  };

  test("no session: 401. A requester, an agent: 403. Unlicensed: 402. Nothing changes.", async () => {
    const snapshot = async () => JSON.stringify([await m365.m365MailView(), (await pool().query("SELECT id, address FROM hd_m365_mailboxes ORDER BY id")).rows]);
    const before = await snapshot();
    for (const [name, make, handler, params] of routes()) {
      assert.equal((await call(handler, make(), params)).status, 401, name);
      for (const who of [U.req, U.agent, U.outsider]) assert.equal((await call(handler, as(make(), who), params)).status, 403, `${name} as ${who.name}`);
      licensed = false;
      assert.equal((await call(handler, as(make(), U.manager), params)).status, 402, `${name} unlicensed`);
      licensed = true;
    }
    assert.equal(await snapshot(), before);
  });

  test("every admin route is behind the desk gate that also holds the Duo desk rule; the view never carries a secret", async () => {
    const root = path.join(__dirname, "..", "src", "app", "api", "helpdesk", "admin", "m365-mail");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (n === "route.ts") files.push(p);
      }
    };
    walk(root);
    assert.equal(files.length, 6);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\) \{\n([^\n]+)\n([^\n]+)/g)];
      assert.ok(handlers.length >= 1, f);
      for (const h of handlers) {
        assert.match(h[2], /const gate = await hdAnyCapGate\(CAPS\);/, `${f} ${h[1]}`);
        assert.match(h[3], /if \(gate instanceof NextResponse\) return gate;/, `${f} ${h[1]}`);
      }
      assert.match(src, /const CAPS: HdCap\[\] = \["settings\.manage", "channels\.manage"\];/);
    }
    const view = await call(rootRoute.GET, req(API, U.manager, undefined, "GET"));
    assert.equal(view.status, 200);
    const c = await cfg();
    const text = JSON.stringify(view.body);
    assert.ok(!text.includes(c.secret) && !text.includes(c.notify_key));
    for (const mb of view.body.mailboxes) assert.ok(!("sub_state" in mb) && !("delta_link" in mb));
    // The rig's seam shows in the view only because the test set it; a real install's view has no such field.
    assert.equal(view.body.test_base, fake.base);
  });

  test("disconnecting a mailbox: its subscription is deleted, its help addresses go back to the webhook, nothing in the mailbox is touched", async () => {
    await m365.m365MailSweep();
    const salesId = (await pool().query("SELECT id FROM hd_m365_mailboxes WHERE address = $1", [SALES])).rows[0].id;
    const had = [...fake.subscriptions.values()].some((s) => s.mailbox === SALES);
    const messagesBefore = fake.mailboxes.get(SALES)!.messages.size;
    const r = await call(boxRoute.DELETE, req(`${API}/mailboxes/${salesId}`, U.manager, undefined, "DELETE"), { id: String(salesId) });
    assert.deepEqual([r.status, r.body.address, r.body.unlinked], [200, SALES, [SALES]]);
    assert.ok(had && ![...fake.subscriptions.values()].some((s) => s.mailbox === SALES));
    assert.equal(fake.mailboxes.get(SALES)!.messages.size, messagesBefore);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_messages WHERE mailbox_id = $1", [salesId])).rows[0].n, 0);
    assert.equal((await m365State.m365State()).linked.has(boxSales.id), false);
    assert.deepEqual((await audits("helpdesk.m365.mailbox_disconnected")).at(-1)!.details, { address: SALES, help_addresses: [SALES] });
    assert.equal((await call(boxRoute.DELETE, req(`${API}/mailboxes/${salesId}`, U.manager, undefined, "DELETE"), { id: String(salesId) })).status, 404);
    // Removing a help address takes its link with it.
    await mailboxes.deleteMailbox(boxBilling.id, by());
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_links WHERE mailbox_id = $1", [boxBilling.id])).rows[0].n, 0);
  });

  test("every audit action this adds has a label, and the secret is in none of them", async () => {
    const rows = (await pool().query("SELECT action, details FROM audit_log WHERE action LIKE 'helpdesk.m365.%' AND at > now() - interval '1 hour'")).rows;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["connection_saved", "connection_removed", "settings_changed", "mailbox_connected", "mailbox_disconnected", "address_changed", "access_checked", "subscription_failed", "intake_failed", "send_refused"]) {
      assert.ok(auditLabels.hasActionLabel(`helpdesk.m365.${a}`), a);
      if (a !== "connection_removed" || fs.existsSync(EE_SETUP)) assert.ok(actions.has(`helpdesk.m365.${a}`), `${a} was written`);
    }
    const all = JSON.stringify(rows);
    for (const a of fake.apps.values()) for (const s of a.secrets) assert.ok(!all.includes(s));
    assert.ok(!all.includes((await cfg()).notify_key));
  });
});

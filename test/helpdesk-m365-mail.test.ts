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
//   - the routes' permissions (settings.manage for the connection and the
//     list of mailboxes, channels.manage for the rest);
//   - the security review of 1.20.7: all-"none" results are a failed check,
//     hostile addresses in the PowerShell block, organisation-wide access
//     recorded and confirmed, idle mailboxes, named-only envelopes, retry
//     accounting and "Try again", Inbox-only notifications and strict ids,
//     cheap rejections and the intake's limits, meeting invites, the "Last
//     messages" diagnostic, the object ID lookup, key rotation.
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
import { createHash } from "node:crypto";
import { INBOX_ID, exchangeHeaders, failResults, passResults, startFakeM365, type FakeApp, type FakeM365, type FakeMessage } from "./helpers/fake-m365";

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
const retryRoute = require("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/retry/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/retry/route");
const messagesRoute = require("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/messages/route") as typeof import("../src/app/api/helpdesk/admin/m365-mail/mailboxes/[id]/messages/route");
const deskRoles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
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
// "lead": a desk role that holds the Email channel capability and not Helpdesk settings (see the permission tests).
const U: Record<"req" | "agent" | "manager" | "outsider" | "lead", Person> = {} as never;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
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
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[KEY, `${KEY}_roles`]]);
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

  const names = { req: "Daniel Okafor", agent: "Ana Kowalski", manager: "Mina Park", outsider: "Noor Haddad", lead: "Tariq Aziz" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const addr = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'UTC') RETURNING id`, [`${STAMP}-${k}`, `${name} ${STAMP.slice(-4)}`, addr]);
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: addr, session, name: `${name} ${STAMP.slice(-4)}` };
  }
  for (const [k, role] of [["agent", "agent"], ["manager", "manager"], ["lead", "team_lead"]] as const) {
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
  deskRoles.setRoleMatrixForTests(null);
  inbound.setInboundAttachmentStoreForTests(null);
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
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[KEY, `${KEY}_roles`]]);
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

  test("no result is only 'Exchange wrote no results at all'; results that are all 'none' are a FAILED check", () => {
    const nothing = verdict({ ...base, results: undefined, authAs: [] });
    assert.equal(nothing.v.kind, "none");
    assert.equal(nothing.v.auth, undefined);
    assert.equal(nothing.state.state, "none");
    assert.equal(nothing.v.note, "no AuthAs stamp; no Authentication-Results header");
    // Exchange evaluated it and found nothing signed and nothing published: checked, not passed. The trust toggle
    // ("Trust sender addresses without SPF or DKIM results") reads state "none" only, so it never applies here.
    const empty = verdict({ ...base, results: "spf=none (sender IP is 203.0.113.9) smtp.mailfrom=customer.example; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=customer.example;compauth=none reason=405", authAs: ["Anonymous"] });
    assert.equal(empty.v.kind, "results");
    assert.deepEqual(empty.v.auth, { spf: "none", envelopeFrom: "customer.example", dkim: "none", dmarc: "none" });
    assert.deepEqual([empty.state.state, empty.state.ok, empty.state.checked], ["fail", false, true]);
    assert.match(empty.v.note, /^AuthAs stamp: anonymous; first of 1 Authentication-Results: spf=none, dkim=none, dmarc=none, compauth=none \(reason 405\)$/);
    // Even a single method named, with no verdict worth the name.
    const one = verdict({ ...base, results: "dkim=none (message not signed) header.d=none", authAs: ["Anonymous"] });
    assert.deepEqual([one.v.kind, one.state.state], ["results", "fail"]);
    // No authserv-id before the first method, as Microsoft's own examples show, and one in front: both read.
    assert.equal(verdict({ ...base, results: `mx.microsoft.com; ${passResults("customer.example")}`, authAs: ["Anonymous"] }).state.state, "pass");
  });

  test("DMARC fails closed: a pass with no readable header.from is no pass", () => {
    for (const results of [
      "spf=none smtp.mailfrom=other.example; dkim=none header.d=none;dmarc=pass action=none;compauth=pass reason=100",
      "spf=none smtp.mailfrom=other.example; dkim=none header.d=none;dmarc=pass action=none header.from=;compauth=pass reason=100",
      "spf=none smtp.mailfrom=other.example; dkim=none header.d=none;dmarc=pass action=none header.from=<nonsense>;compauth=pass reason=100",
      "spf=none smtp.mailfrom=other.example; dkim=none header.d=none;dmarc=pass action=none header.from=other.example;compauth=pass reason=100",
    ]) {
      const r = verdict({ ...base, results, authAs: ["Anonymous"] });
      assert.equal(r.v.auth?.dmarc, "none", results);
      assert.equal(r.state.ok, false, results);
    }
    // The organisational domain is aligned (relaxed), as for the webhook's verdicts.
    assert.equal(verdict({ ...base, fromEmail: "cara@mail.customer.example", results: "spf=none smtp.mailfrom=x.example; dkim=none header.d=none;dmarc=pass action=none header.from=customer.example;compauth=pass reason=100", authAs: ["Anonymous"] }).state.state, "pass");
  });

  test("Microsoft's documented words and codes: bestguesspass and softpass are no pass; compauth is read by its reason code too", () => {
    // dmarc=bestguesspass: the domain has no DMARC record. Not a pass; with nothing else aligned, a failed check.
    const guess = verdict({ ...base, results: "spf=none smtp.mailfrom=other.example; dkim=none header.d=none;dmarc=bestguesspass action=none header.from=customer.example;compauth=pass reason=109", authAs: ["Anonymous"] });
    assert.equal(guess.v.auth?.dmarc, "none");
    assert.equal(guess.state.state, "fail");
    // ... but an aligned SPF pass beside it is still a pass (the existing alignment rule).
    assert.equal(verdict({ ...base, results: "spf=pass smtp.mailfrom=customer.example; dkim=none header.d=none;dmarc=bestguesspass action=none header.from=customer.example;compauth=pass reason=109", authAs: ["Anonymous"] }).state.state, "pass");
    const cls = (tail: string) => message.parseExchangeResults(`spf=pass smtp.mailfrom=customer.example;${tail}`).compauth;
    // fail: 000, 001, 002, 010 and 6xx, whatever the word says.
    for (const code of ["000", "001", "002", "010", "601", "699"]) {
      assert.equal(cls(`compauth=fail reason=${code}`), "fail", code);
      assert.equal(cls(`compauth=pass reason=${code}`), "fail", `${code} under the word pass`);
    }
    // pass: 1xx and 7xx. softpass: 2xx. none: 3xx, 4xx, 5xx, 9xx.
    for (const code of ["100", "115", "130", "701", "704"]) assert.equal(cls(`compauth=pass reason=${code}`), "pass", code);
    for (const code of ["201", "202"]) assert.equal(cls(`compauth=softpass reason=${code}`), "softpass", code);
    for (const code of ["301", "405", "501", "905"]) assert.equal(cls(`compauth=none reason=${code}`), "none", code);
    // The word and the code disagree: the weaker one. The word fail with any code: fail. No code: the word.
    assert.equal(cls("compauth=pass reason=201"), "softpass");
    assert.equal(cls("compauth=pass reason=405"), "none");
    assert.equal(cls("compauth=fail reason=100"), "fail");
    assert.equal(cls("compauth=pass"), "pass");
    assert.equal(cls("compauth=gibberish reason=1"), "none");
    // A fail by code alone turns a passing message into a failed check; a pass or soft pass alone never makes one pass.
    const spoof = verdict({ ...base, results: "spf=pass smtp.mailfrom=customer.example; dkim=pass header.d=customer.example;dmarc=pass action=none header.from=customer.example;compauth=pass reason=601", authAs: ["Anonymous"] });
    assert.deepEqual([spoof.v.auth?.dmarc, spoof.state.state], ["fail", "fail"]);
    for (const tail of ["compauth=pass reason=100", "compauth=softpass reason=201"]) {
      assert.equal(verdict({ ...base, results: `spf=none smtp.mailfrom=other.example; dkim=none header.d=none;dmarc=none action=none header.from=customer.example;${tail}`, authAs: ["Anonymous"] }).state.state, "fail", tail);
    }
    assert.match(spoof.v.note, /compauth=fail \(reason 601\)$/);
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
    // Exactly one stamp: two that both say Internal are not Exchange's one.
    assert.notEqual(verdict({ ...internal, results: undefined, authAs: ["Internal", "Internal"] }).v.kind, "internal");
    // Intra-organisation spoofing as Microsoft codes it (compauth reason 010 or 601): never internal, whatever the word.
    assert.notEqual(verdict({ ...internal, results: "dkim=none header.d=none;dmarc=none action=none header.from=acme.example;compauth=pass reason=601", authAs: ["Internal"] }).v.kind, "internal");
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
    // The first read has no body: the same answer, with nothing in it.
    const head = message.graphMessageToInbound(msg({ body: undefined }), [], ["help@acme.example"])!.email;
    assert.deepEqual([head.from.email, head.text, head.html, head.recipients], ["cara@customer.example", "", "", ["help@acme.example"]]);
    assert.deepEqual(message.graphMessageMeta(msg({ parentFolderId: "F1", "@odata.type": "#microsoft.graph.eventMessage" })), { id: "AAMk1", receivedAt: "", isDraft: false, hasAttachments: false, parentFolderId: "F1", isEventMessage: true });
    assert.equal(message.graphMessageMeta(msg({}))!.isEventMessage, false);
  });

  test("no SMTP sender address: no mail (null), and Graph's `sender` stands in only for mail Exchange stamped Internal", () => {
    assert.equal(message.graphMessageToInbound({ id: "x", body: {} }, [], []), null);
    // An X.500 name, an empty or a malformed address: not an SMTP sender.
    for (const address of ["/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=ANA", "", "not an address", "a@b@c", "<script>@x"]) {
      assert.equal(message.graphMessageToInbound(msg({ from: { emailAddress: { name: "X", address } }, sender: undefined }), [], ["help@acme.example"]), null, address);
    }
    const noFrom = (headers: ReturnType<typeof exchangeHeaders>) => message.graphMessageToInbound(msg({ from: undefined, sender: { emailAddress: { name: "Ana", address: "ana@acme.example" } }, internetMessageHeaders: headers }), [], ["help@acme.example"]);
    // From outside (Exchange's results are there, no Internal stamp): the submitting account is nobody's proof.
    assert.equal(noFrom(exchangeHeaders({ from: "", to: "help@acme.example", messageId: "s1@x", results: passResults("acme.example"), authAs: ["Anonymous"] })), null);
    assert.equal(noFrom(exchangeHeaders({ from: "", to: "help@acme.example", messageId: "s2@x", results: undefined, authAs: [] })), null);
    // Stamped Internal by Exchange: the account that submitted it is the sender.
    const internal = noFrom(exchangeHeaders({ from: "", to: "help@acme.example", messageId: "s3@x", results: undefined, authAs: ["Internal"] }))!;
    assert.deepEqual([internal.email.from.email, internal.verdict.kind], ["ana@acme.example", "internal"]);
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
    // The envelope names only the help addresses the mail was sent to: a team alias never sees an address it was not.
    assert.deepEqual(bcc.recipients, ["help@acme.example"], "none named: the mailbox's main help address alone");
    const own = ["help@acme.example", "billing@acme.example", "returns@acme.example"];
    const toMain = message.graphMessageToInbound(msg({}), [], own)!.email;
    assert.deepEqual(toMain.recipients, ["help@acme.example"]);
    const toAlias = message.graphMessageToInbound(msg({ toRecipients: [{ emailAddress: { address: "help@acme.example" } }], internetMessageHeaders: exchangeHeaders({ from: "c@customer.example", to: "Returns <RETURNS@acme.example>", messageId: "r@x" }) }), [], own)!.email;
    // The To line named the alias; Graph's typed recipient shows the main address (aliases are rewritten by default): both were named.
    assert.deepEqual(toAlias.recipients, ["help@acme.example", "returns@acme.example"]);
    const ccOnly = message.graphMessageToInbound(msg({ toRecipients: [], ccRecipients: [{ emailAddress: { address: "billing@acme.example" } }], internetMessageHeaders: exchangeHeaders({ from: "c@customer.example", to: "bob@elsewhere.example", cc: "billing@acme.example", messageId: "cc@x" }) }), [], own)!.email;
    assert.deepEqual(ccOnly.recipients, ["billing@acme.example"]);
    // A plus-tagged reply address names its help address.
    assert.deepEqual(message.graphMessageToInbound(msg({ toRecipients: [], internetMessageHeaders: exchangeHeaders({ from: "c@customer.example", to: `billing+hd-${TOKEN}@acme.example`, messageId: "p@x" }) }), [], own)!.email.recipients, ["billing@acme.example"]);
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
    assert.equal(lines[1], `New-ServicePrincipal -AppId '${ids.clientId}' -ObjectId '${ids.spObjectId}' -DisplayName 'CompassDocs Helpdesk Mail'`);
    // EmailAddresses, as Microsoft's filterable-properties page asks (not PrimarySmtpAddress); a whole address needs no "smtp:".
    assert.equal(lines[2], `New-ManagementScope -Name 'CompassDocs help mailboxes' -RecipientRestrictionFilter 'EmailAddresses -eq ''help@acme.com'' -or EmailAddresses -eq ''billing@acme.com'''`);
    assert.match(lines[3], /-Role 'Application Mail\.ReadWrite' -CustomResourceScope 'CompassDocs help mailboxes'$/);
    assert.match(lines[4], /-Role 'Application Mail\.Send' -CustomResourceScope 'CompassDocs help mailboxes'$/);
    // Looking, not changing: each mailbox's sign-in name and object ID, for the "Object ID or sign-in name" field.
    assert.equal(lines[5], "Get-EXOMailbox -Identity 'help@acme.com' | Format-List UserPrincipalName, ExternalDirectoryObjectId");
    assert.equal(lines[6], "Get-EXOMailbox -Identity 'billing@acme.com' | Format-List UserPrincipalName, ExternalDirectoryObjectId");
    // The test command's real columns; -Resource is the address until the desk knows the mailbox's object ID.
    assert.equal(lines[7], `Test-ServicePrincipalAuthorization -Identity '${ids.spObjectId}' -Resource 'help@acme.com' | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope`);
    assert.equal(lines.length, 8);
    const oid = "5d2f8c1a-9b3e-4f70-8a6d-1c2e3f4a5b6c";
    assert.ok(shared.restrictCommands({ ...ids, addresses: ["help@acme.com"], first: true, graphIds: { "help@acme.com": oid.toUpperCase() } })!.includes(`-Resource '${oid}' | Format-Table`));
    // A sign-in name is not what -Resource is documented to take: the address stays.
    assert.ok(shared.restrictCommands({ ...ids, addresses: ["help@acme.com"], first: true, graphIds: { "help@acme.com": "svc-help@acme.com" } })!.includes("-Resource 'help@acme.com' |"));
    const later = shared.restrictCommands({ ...ids, addresses: ["help@acme.com"], first: false })!;
    assert.ok(later.startsWith("Connect-ExchangeOnline\nSet-ManagementScope -Identity 'CompassDocs help mailboxes' -RecipientRestrictionFilter 'EmailAddresses -eq ''help@acme.com'''\nGet-EXOMailbox "));
    assert.doesNotMatch(later, /New-ServicePrincipal/);
    assert.equal(shared.restrictCommands({ ...ids, addresses: [], first: true }), null);
    assert.equal(shared.restrictCommands({ clientId: ids.clientId, spObjectId: "", addresses: ["a@b.co"], first: true }), null);
  });

  test("hostile addresses: nothing an admin pastes into PowerShell can run, expand or end a string", () => {
    // PowerShell expands $(...) and `...` and ends a string at " inside DOUBLE quotes: none of that inside single quotes,
    // where the only character with meaning is the quote itself, doubled. So: no double quote anywhere in the block,
    // every value in single quotes, and a balanced count of single quotes on every line.
    const hostile = [
      "$(Invoke-WebRequest evil.example)@acme.com",
      "`whoami`@acme.com",
      'a";Remove-Mailbox -Identity ceo;"@acme.com',
      "a'; Remove-Mailbox ceo; '@acme.com",
      "a b@acme.com",
      "a\nRemove-Mailbox ceo@acme.com",
      "a;b@acme.com",
      "a|b@acme.com",
      "a&b@acme.com",
      "a(b)@acme.com",
      "a{b}@acme.com",
      "help@acme.com' -or Name -like '*",
      "help@$env:USERDNSDOMAIN",
      "help@acme.com’; whoami",
      "hélp@acme.com",
      "help+tag@acme.com",
      ".help@acme.com",
      "help.@acme.com",
      "help@acme",
      "help@-acme.com",
      "@acme.com",
      `${"a".repeat(70)}@acme.com`,
    ];
    for (const a of hostile) {
      assert.equal(shared.cleanM365Address(a), null, a);
      assert.notEqual(shared.m365AddressProblem(a), "", a);
    }
    // What is accepted: letters, digits, ".", "_", "-" and "'" before the @, lower-cased.
    for (const [raw, clean] of [["Help@Acme.com", "help@acme.com"], ["o'brien@acme.com", "o'brien@acme.com"], ["it_help-desk.2@sub.acme.co.uk", "it_help-desk.2@sub.acme.co.uk"], [" a@b.co ", "a@b.co"]] as const) {
      assert.equal(shared.cleanM365Address(raw), clean);
      assert.equal(shared.m365AddressProblem(raw), "");
    }
    assert.equal(shared.m365AddressProblem(""), "Enter the mailbox's address.");
    assert.match(shared.m365AddressProblem("help+x@acme.com"), /Leave out the \+ tag/);
    // Hostile addresses that reached the generator anyway (an old row, a bug) are left out, never written.
    const mixed = shared.restrictCommands({ ...ids, addresses: [...hostile, "o'brien@acme.com", "help@acme.com"], first: true })!;
    for (const line of mixed.split("\n")) {
      assert.doesNotMatch(line, /["`$;&{}\r‘’]/, line);
      assert.equal((line.match(/'/g) ?? []).length % 2, 0, `balanced quotes: ${line}`);
      assert.doesNotMatch(line, /Remove-Mailbox|Invoke-WebRequest|whoami/);
      // The only pipes are the block's own, outside every quoted value.
      assert.ok(line.split("'").every((part, i) => i % 2 === 0 || !part.includes("|")), line);
    }
    // The apostrophe is doubled once as a filter string and once more inside the PowerShell literal around the filter.
    assert.equal(shared.scopeFilter(["o'brien@acme.com"]), "EmailAddresses -eq 'o''brien@acme.com'");
    assert.ok(mixed.includes("-RecipientRestrictionFilter 'EmailAddresses -eq ''o''''brien@acme.com'' -or EmailAddresses -eq ''help@acme.com'''\n"));
    assert.ok(mixed.includes("Get-EXOMailbox -Identity 'o''brien@acme.com' |"));
    assert.equal(shared.psLiteral("it's $(x) `y` \"z\""), "'it''s $(x) `y` \"z\"'");
    // Only hostile addresses: nothing to name, no block at all.
    assert.equal(shared.restrictCommands({ ...ids, addresses: hostile, first: true }), null);
    // A hostile object ID never reaches the block either.
    assert.ok(shared.restrictCommands({ ...ids, addresses: ["help@acme.com"], first: true, graphIds: { "help@acme.com": "x'; whoami; '" } })!.includes("-Resource 'help@acme.com' |"));
    for (const [raw, clean] of [["", ""], ["  ", ""], ["5D2F8C1A-9B3E-4F70-8A6D-1C2E3F4A5B6C", "5d2f8c1a-9b3e-4f70-8a6d-1c2e3f4a5b6c"], ["Svc-Help@Acme.com", "svc-help@acme.com"], ["$(x)", null], ["a b", null], [5, null]] as const) {
      assert.equal(shared.cleanM365GraphId(raw), clean, String(raw));
    }
  });

  test("which permissions in the app's token reach every mailbox", () => {
    const wide = ["Mail.Read", "Mail.ReadWrite", "Mail.ReadBasic", "Mail.ReadBasic.All", "Mail.Send", "Mail-Advanced.ReadWrite.All", "MailboxItem.Read.All", "MailboxItem.ImportExport.All", "MailboxFolder.Read.All", "MailboxFolder.ReadWrite.All"];
    assert.deepEqual(shared.tenantWideRoles(wide), wide);
    // Not mail: other families, and names that only look alike.
    assert.deepEqual(shared.tenantWideRoles(["User.Read.All", "Calendars.Read", "MailTips.ReadBasic.All", "MailboxSettings.Read", "Mailbox", "Mail", "Mail.", "Mail.Read; rm", "full_access_as_app"]), []);
    // The hyphenated one survives the token reader.
    const jwt = (c: unknown) => `x.${Buffer.from(JSON.stringify(c)).toString("base64url")}.y`;
    assert.deepEqual(shared.tenantWideRoles(graphLib.tokenClaims(jwt({ roles: ["Mail-Advanced.ReadWrite.All", "User.Read.All"] })).roles), ["Mail-Advanced.ReadWrite.All"]);
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
    const v = await m365.m365MailView();
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
    // (With that grant, connecting anything needs an explicit yes: see "an app that was given the whole organisation".)
    for (const a of [`team@${DOMAIN}`, `all@${DOMAIN}`, `partner@${DOMAIN}`, `nobody@${DOMAIN}`, "someone@another-org.example"]) {
      const r = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: a, confirm_tenant_wide: true }));
      assert.equal(r.status, 422, a);
      assert.equal(r.body.code, "not_a_mailbox");
      assert.match(r.body.error, /found no mailbox with that address\. Distribution lists, Microsoft 365 groups, mail contacts and mailboxes in another organisation can't be connected\. Use a shared mailbox instead\./);
    }
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_mailboxes")).rows[0].n, 0);
    assert.match((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: "help+x@acme.example" }))).body.error, /\+ tag/);
    assert.equal((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: "nope" }))).status, 400);
    // Addresses PowerShell or a path would give meaning to are refused before Microsoft is asked anything.
    const asked = fake.log.length;
    for (const a of ["$(whoami)@acme.example", "a'; Remove-Mailbox ceo; '@acme.example", "a b@acme.example", 'a"b@acme.example', "../x@acme.example", 7]) {
      await assert.rejects(m365.connectM365Mailbox(a, by(), { confirmTenantWide: true }), (e: Error & { status?: number }) => e.status === 400, String(a));
    }
    assert.equal((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: "$(whoami)@acme.example", confirm_tenant_wide: true }))).status, 400);
    assert.equal((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: HELP, graph_id: "not an id or a name", confirm_tenant_wide: true }))).status, 400);
    assert.equal(fake.log.length, asked);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_mailboxes")).rows[0].n, 0);
    app.roles = [];
    graphLib.clearM365TokensForTests();
    // The half-hourly look (here: the sweep, with the last look made old) records that the grant is gone.
    await pool().query("UPDATE settings SET value = jsonb_set(value::jsonb, '{at}', '\"2020-01-01T00:00:00.000Z\"')::text WHERE key = $1", [`${KEY}_roles`]);
    await m365.m365MailSweep();
    assert.deepEqual((await m365.m365MailView()).tenant_wide, []);
  });

  test("a mailbox the app may not read yet is listed, waiting; its help address is linked; the access check says so", async () => {
    const r = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: ` ${HELP.toUpperCase()} ` }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
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
    assert.ok(text.includes(`-AppId '${app.appId}' -ObjectId '${app.spId}'`) && text.includes(`''${HELP}''`));

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
    assert.deepEqual((await m365.m365MailView()).tenant_wide, ["Mail.ReadWrite", "Mail.Send"]);
    app.roles = [];
    const back = await call(accessRoute.POST, req(`${API}/check-access`, U.manager, {}));
    assert.deepEqual([back.body.access.tenant_wide, back.body.access.probe], [[], null]);
    assert.deepEqual(back.body.view.tenant_wide, []);
    assert.equal((await call(accessRoute.POST, req(`${API}/check-access`, U.manager, { probe: "not an address" }))).status, 400);
    assert.equal((await call(accessRoute.POST, req(`${API}/check-access`, U.manager, { probe: "$(whoami)@acme.example" }))).status, 400);
  });

  test("organisation-wide access is recorded without anyone pressing Check access: at the save and by the timer", async () => {
    // Granted in Entra behind the desk's back (one of the newer mailbox-wide permissions).
    app.roles = ["MailboxItem.Read.All", "User.Read.All"];
    graphLib.clearM365TokensForTests();
    const stale = () => pool().query("UPDATE settings SET value = jsonb_set(value::jsonb, '{at}', '\"2020-01-01T00:00:00.000Z\"')::text WHERE key = $1", [`${KEY}_roles`]);
    // Within half an hour of the last look the sweep does not sign in again for it...
    await m365.m365MailSweep();
    assert.deepEqual((await m365.m365MailView()).tenant_wide, []);
    // ...after that it does, and the page's warning is there with no check pressed. The change is audited.
    await stale();
    await m365.m365MailSweep();
    const v = await m365.m365MailView();
    assert.deepEqual(v.tenant_wide, ["MailboxItem.Read.All"]);
    assert.ok(v.tenant_wide_at && Date.now() - Date.parse(v.tenant_wide_at) < 60_000);
    assert.deepEqual((await audits("helpdesk.m365.tenant_wide_changed")).at(-1)!.details, { tenant_wide: ["MailboxItem.Read.All"], was: [] });
    assert.ok(auditLabels.hasActionLabel("helpdesk.m365.tenant_wide_changed"));
    // Saving the connection records what the new token carries, too.
    app.roles = ["Mail-Advanced.ReadWrite.All"];
    const saved = await call(rootRoute.PUT, req(API, U.manager, { tenant: fake.tenantId, client_id: app.appId, secret: "" }, "PUT"));
    assert.deepEqual([saved.status, saved.body.tenant_wide, saved.body.view.tenant_wide], [200, ["Mail-Advanced.ReadWrite.All"], ["Mail-Advanced.ReadWrite.All"]]);
    assert.deepEqual((await audits("helpdesk.m365.connection_saved")).at(-1)!.details.tenant_wide, ["Mail-Advanced.ReadWrite.All"]);

    // While it is there, the list alone decides what the desk reads: connecting a mailbox needs an explicit yes.
    const no = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: OTHER }));
    assert.deepEqual([no.status, no.body.code], [409, "tenant_wide"]);
    assert.match(no.body.error, /can read every mailbox in your organisation \(Mail-Advanced\.ReadWrite\.All is granted in Entra\)/);
    assert.equal((await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: OTHER, confirm_tenant_wide: "true" }))).status, 409, "only the boolean true is a yes");
    await assert.rejects(m365.connectM365Mailbox(OTHER, by(), { confirmTenantWide: false }), (e: Error & { code?: string }) => e.code === "tenant_wide");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_mailboxes WHERE address = $1", [OTHER])).rows[0].n, 0);
    const yes = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: OTHER, confirm_tenant_wide: true }));
    assert.deepEqual([yes.status, yes.body.mailbox.waiting, yes.body.mailbox.linked, yes.body.mailbox.tenant_wide], [201, false, null, ["Mail-Advanced.ReadWrite.All"]]);
    assert.deepEqual((await audits("helpdesk.m365.mailbox_connected")).at(-1)!.details, {
      address: OTHER,
      waiting_for_access: false,
      linked_help_address: null,
      tenant_wide: ["Mail-Advanced.ReadWrite.All"],
      tenant_wide_confirmed: true,
    });

    // No help address lives on it, so it is NOT read: no delta query, no subscription, and the page says so.
    const otherId = yes.body.mailbox.id as number;
    const mine = yes.body.view.mailboxes.find((m: { id: number }) => m.id === otherId);
    assert.deepEqual([mine.mode, mine.addresses], ["idle", []]);
    assert.equal(shared.modeSentence("idle", 2, ""), "No help address lives here yet, so it is not being read.");
    fake.addMessage(OTHER, { subject: `${STAMP} the CEO's private mail` });
    const calls = () => fake.calls(new RegExp(`/users/${encodeURIComponent(OTHER).replace(/[.+]/g, "\\$&")}/`, "i")).length;
    const before = calls();
    await pool().query("UPDATE hd_m365_mailboxes SET poll_due = true WHERE id = $1", [otherId]);
    await m365.m365MailSweep();
    assert.deepEqual(await poll(otherId), { ok: false, idle: true, error: "No help address lives here yet, so it is not being read." });
    const now = await call(checkRoute.POST, req(`${API}/mailboxes/${otherId}/check`, U.manager, {}), { id: String(otherId) });
    assert.deepEqual([now.status, now.body.ok, now.body.idle, now.body.error], [200, false, true, "No help address lives here yet, so it is not being read."]);
    assert.equal(calls(), before, "Microsoft was not asked for anything in that mailbox");
    assert.equal((await ticketFor(`${STAMP} the CEO's private mail`)).length, 0);
    assert.equal(fake.mailboxes.get(OTHER)!.messages.size, 1);
    assert.equal([...fake.subscriptions.values()].filter((x) => x.mailbox === OTHER).length, 0);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_m365_messages WHERE mailbox_id = $1", [otherId])).rows[0].n, 0);

    await m365.disconnectM365Mailbox(otherId, by());
    fake.mailboxes.get(OTHER)!.messages.clear();
    app.roles = [];
    graphLib.clearM365TokensForTests();
    await stale();
    await m365.m365MailSweep();
    assert.deepEqual((await m365.m365MailView()).tenant_wide, []);
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
    assert.deepEqual([r.taken_in, r.dropped, r.last_error], [1, 0, ""]);
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
    // The other form Microsoft documents: the token expired (a 4xx with the code syncStateNotFound).
    const more = inboxMessage({ subject: `${STAMP} after the token expired` });
    mb.expireDelta = "token";
    assert.deepEqual(await poll(), { ok: true });
    assert.equal(fake.calls(/messages\/delta 404/).length, 1);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE subject LIKE $1", [`${STAMP}%`])).rows[0].n, tickets + 2);
    assert.equal((await seen(more.id)).outcome, "created");
    assert.equal((await row()).last_error, "", "a lost link is not 'no mailbox with that address'");
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
    // Looking at the page, from whatever address, writes nothing.
    const stored = await getSetting(KEY);
    await call(rootRoute.GET, new Request("http://localhost:4999/api/helpdesk/admin/m365-mail", { headers: { cookie: `compass_session=${U.manager.session}`, host: "localhost:4999", origin: "http://localhost:4999" } }));
    assert.equal(await getSetting(KEY), stored);
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
    // Only the SHA-256 of the clientState is kept: a copy of the database is not a way to forge a notification.
    assert.deepEqual([r.sub_id, r.sub_state, r.sub_error], [sub.id, sha(sub.clientState), ""]);
    assert.ok(!JSON.stringify(r).includes(sub.clientState));
    assert.match(sub.prefer, /IdType="ImmutableId"/, "notifications name messages by the ids every other call uses");
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
    // Exchange evaluated it and found nothing (nothing signed, nothing published): a FAILED check, which the toggle never covers.
    inboxMessage({ subject: `${STAMP} all none is not no result`, from: fromReq(), fromDomainResults: "spf=none (sender IP is 198.51.100.7) smtp.mailfrom=example.test; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=example.test;compauth=none reason=405" });
    inboxMessage({ subject: `${STAMP} best guess is not a pass`, from: fromReq(), fromDomainResults: "spf=none smtp.mailfrom=elsewhere.example; dkim=none header.d=none;dmarc=bestguesspass action=none header.from=example.test;compauth=softpass reason=201" });
    await poll();
    assert.equal((await ticketFor(`${STAMP} trusted without results`))[0].requester_id, U.req.id);
    for (const subject of ["all none is not no result", "best guess is not a pass"]) {
      const [t] = await ticketFor(`${STAMP} ${subject}`);
      assert.equal(t.requester_id, null, subject);
      const note = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id", [t.id])).rows.map((r) => r.body).join("\n");
      assert.match(note, /failed the sender check/, subject);
    }
    assert.equal((await ticketFor(`${STAMP} still failing`))[0].requester_id, null);
    await inbound.saveInboundAuthSettings({ trust_unverified_senders: false });
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
    assert.deepEqual([r.sub_id, r.sub_state], [sub()!.id, sha(sub()!.clientState)], "and the row holds its id and its clientState's hash");
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

// --- 1.20.7 security review: what a notification may name --------------------------------

describe("what a notification may name", () => {
  const post = async (items: unknown[], ip = "198.51.100.31") => {
    const k = (await cfg()).notify_key;
    const a = await m365.handleM365Notification(new Request(`http://localhost/api/helpdesk/m365/notify/${k}`, { method: "POST", body: JSON.stringify({ value: items }) }), k, { ip });
    if (a.work) await a.work();
    return a.status;
  };
  const subOf = (address = HELP) => [...fake.subscriptions.values()].find((s) => s.mailbox === address)!;
  const item = (id: string, address = HELP) => ({ subscriptionId: subOf(address).id, clientState: subOf(address).clientState, changeType: "created", resourceData: { id } });
  const quiet = () => pool().query("UPDATE hd_m365_mailboxes SET poll_due = false, last_poll_at = now()");

  before(async () => {
    m365.resetM365NotifyLimitsForTests();
    await m365.m365MailSweep();
    assert.ok(subOf(), "the help mailbox has its subscription");
  });

  test("only a message in the Inbox: one that lies elsewhere in the mailbox is not taken in, whoever names it", async () => {
    const mb = fake.mailboxes.get(HELP)!;
    mb.folders.set("folder-sent", "Sent Items");
    // A reply someone sent from the shared mailbox years ago, sitting in Sent Items.
    const sent = inboxMessage({ subject: `${STAMP} in Sent Items`, folder: "folder-sent" });
    await quiet();
    assert.equal(await post([item(sent.id)]), 202);
    assert.equal((await ticketFor(`${STAMP} in Sent Items`)).length, 0);
    assert.equal(await seen(sent.id), undefined, "no claim is left behind");
    assert.equal(mb.messages.get(sent.id)!.isRead, false, "and the message is untouched");
    assert.equal((await row()).poll_due, true, "the next read of the Inbox decides");
    // Only its headers were read: no body, no attachment, no change.
    const reads = fake.requests.filter((l) => l.includes(`/messages/${encodeURIComponent(sent.id)}`));
    assert.ok(reads.length === 1 && reads[0].startsWith("GET ") && reads[0].includes("parentFolderId") && !reads[0].includes("$select=id,body"), JSON.stringify(reads));
    // The Inbox read lists the Inbox only, so it does not bring it either.
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await ticketFor(`${STAMP} in Sent Items`)).length, 0);
    // The same kind of notification for a message that IS in the Inbox is taken in at once, with no Inbox read.
    const ok = inboxMessage({ subject: `${STAMP} in the Inbox` });
    const deltas = fake.calls("/messages/delta").length;
    assert.equal(await post([item(ok.id)]), 202);
    assert.equal((await ticketFor(`${STAMP} in the Inbox`)).length, 1);
    assert.equal(fake.calls("/messages/delta").length, deltas);
    // The Inbox's own id was asked for once and kept.
    assert.equal((await row()).inbox_folder_id, INBOX_ID);
    assert.equal(fake.requests.filter((l) => l.includes(`/users/${encodeURIComponent(HELP)}/mailFolders/inbox?$select=id`) && l.startsWith("GET")).length >= 1, true);
    mb.messages.delete(sent.id);
  });

  test("an id that is not written the way Graph writes ids is never fetched", async () => {
    await quiet();
    const before = fake.requests.length;
    for (const id of ["..", `../../users/${OTHER}/messages/x`, "AAMk/../../x-0123456789", "AAMkAGI2%2F..%2F0123456789", "short", "a".repeat(1100), "AAMk id with spaces 123456", "AAMk?$select=body#123456789", "AAMk\u0000null0123456789012", ""]) {
      assert.equal(await post([item(id)]), 202, id);
    }
    assert.equal(fake.requests.length, before, "Microsoft was asked for nothing");
    assert.equal((await row()).poll_due, true, "the Inbox is read instead");
  });

  test("more notifications in one POST than are read: every subscribed mailbox is read at the next tick; from a stranger, nothing", async () => {
    const salesId = (await pool().query("SELECT id FROM hd_m365_mailboxes WHERE address = $1", [SALES])).rows[0].id;
    await quiet();
    const filler = Array.from({ length: m365.M365_NOTIFY_LIMITS.items + 20 }, () => ({ subscriptionId: "nobody", clientState: "x", changeType: "created", resourceData: { id: "AAMkNobody0123456789" } }));
    // Without one item that proves the caller, a long list is a stranger's long list.
    assert.equal(await post(filler), 202);
    assert.deepEqual([(await row()).poll_due, (await row(salesId)).poll_due], [false, false]);
    // With one (Microsoft batching more than this desk reads at once): what was cut off could be anyone's.
    const m = inboxMessage({ subject: `${STAMP} first of a long batch` });
    assert.equal(await post([item(m.id), ...filler]), 202);
    assert.equal((await ticketFor(`${STAMP} first of a long batch`)).length, 1);
    assert.deepEqual([(await row()).poll_due, (await row(salesId)).poll_due], [true, true]);
    await quiet();
  });

  test("the counter for callers without the key stays small and cheap under a flood from many addresses", async () => {
    m365.resetM365NotifyLimitsForTests();
    const t0 = Date.now();
    for (let i = 0; i < 7000; i++) {
      const a = await m365.handleM365Notification(new Request("http://localhost/x", { method: "POST", body: "{}" }), "wrong-key", { ip: `203.0.${i >> 8}.${i & 255}` });
      assert.equal(a.status, 404);
    }
    assert.ok(Date.now() - t0 < 5000, `7,000 refusals took ${Date.now() - t0} ms`);
    // One caller is still counted and turned away.
    let last = 0;
    for (let i = 0; i <= m365.M365_NOTIFY_LIMITS.perIpWrongKey; i++) last = (await m365.handleM365Notification(new Request("http://localhost/x", { method: "POST", body: "{}" }), "wrong-key", { ip: "198.51.100.77" })).status;
    assert.equal(last, 429);
    m365.resetM365NotifyLimitsForTests();
  });
});

// --- 1.20.7 security review: cheap rejections first, and the intake's own limits -------------

describe("before anything is downloaded", () => {
  const pdf = (id = "att-1") => ({ id, name: "report.pdf", contentType: "application/pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20_000, 65)]) });
  /** What was read of one message: its headers, its body, its attachments (the list and each file), its MIME. */
  const kind = (id: string) => {
    const r = fake.requests.filter((l) => l.startsWith("GET ") && l.includes(`/messages/${encodeURIComponent(id)}`));
    return {
      head: r.filter((l) => l.includes("internetMessageHeaders")).length,
      body: r.filter((l) => l.includes("$select=id,body")).length,
      attachments: r.filter((l) => l.includes("/attachments")).length,
      mime: r.filter((l) => l.endsWith("/$value") && !l.includes("/attachments/")).length,
    };
  };
  const fresh = () => {
    m365.resetM365NotifyLimitsForTests();
    inbound.resetInboundRateLimitsForTests();
  };
  const stored: string[] = [];

  before(() => {
    inbound.setInboundAttachmentStoreForTests({
      save: async (i) => {
        stored.push(i.filename);
        return { id: 910000 + stored.length, filename: i.filename, mime: i.mime, size: i.buf.length } as never;
      },
      bind: async () => [],
    });
  });
  after(() => {
    inbound.setInboundAttachmentStoreForTests(null);
    fresh();
  });

  test("a message with no SMTP sender address is dropped, and marked like any other drop", async () => {
    fresh();
    const none = inboxMessage({ subject: `${STAMP} no sender at all`, from: null, attachments: [pdf()] });
    const x500 = inboxMessage({
      subject: `${STAMP} an X.500 sender`,
      from: { name: "Old System", address: "/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=OLD" },
      fromDomainResults: "",
      authAs: [],
      attachments: [pdf()],
    });
    const dropped = (await row()).dropped;
    assert.deepEqual(await poll(), { ok: true });
    for (const m of [none, x500]) {
      const s = await seen(m.id);
      assert.deepEqual([s.state, s.outcome, s.filed], ["done", "skipped_no_sender", true], m.subject);
      assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, true, "marked read, as the workspace chose for handled mail");
      assert.equal((await ticketFor(m.subject)).length, 0);
      assert.deepEqual(kind(m.id), { head: 1, body: 0, attachments: 0, mime: 0 });
    }
    assert.equal((await row()).dropped, dropped + 2);
  });

  test("the desk's own mail, automatic mail and a Message-ID already on a ticket: no attachment is fetched", async () => {
    fresh();
    const loop = inboxMessage({ subject: `${STAMP} our own with a file`, from: { name: "Acme Help", address: HELP }, senderHeaders: [["X-CompassDocs-Helpdesk", "1"]], attachments: [pdf()] });
    const auto = inboxMessage({ subject: `${STAMP} out of office with a file`, senderHeaders: [["Auto-Submitted", "auto-replied"]], attachments: [pdf()] });
    const firstId = `<${newToken()}@mail.sender.example>`;
    const first = inboxMessage({ subject: `${STAMP} original with a file`, internetMessageId: firstId, attachments: [pdf()] });
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await seen(first.id)).outcome, "created");
    const again = inboxMessage({ subject: `${STAMP} original with a file`, internetMessageId: firstId, attachments: [pdf()] });
    assert.deepEqual(await poll(), { ok: true });
    assert.deepEqual([(await seen(loop.id)).outcome, (await seen(auto.id)).outcome, (await seen(again.id)).outcome], ["ignored_loop", "ignored_auto", "duplicate"]);
    // Its own header says it all: not even the body.
    assert.deepEqual(kind(loop.id), { head: 1, body: 0, attachments: 0, mime: 0 });
    assert.deepEqual(kind(auto.id), { head: 1, body: 1, attachments: 0, mime: 0 });
    assert.deepEqual(kind(again.id), { head: 1, body: 1, attachments: 0, mime: 0 });
    // The one that was kept: its body, then the list of its files and the file.
    assert.deepEqual(kind(first.id), { head: 1, body: 1, attachments: 2, mime: 0 });
    assert.deepEqual(stored, ["report.pdf"]);
    assert.equal((await ticketFor(`${STAMP} original with a file`)).length, 1);
    for (const m of [loop, auto, again]) assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, true);
  });

  test("one sender's flood is turned away after one small read each, put off without using up a try, and taken in when its wait is over", async () => {
    fresh();
    const from = { name: "Burst", address: `burst-${STAMP}@customer.example` };
    const ids: string[] = [];
    for (let i = 0; i < m365.M365_INTAKE_LIMITS.perSender + 2; i++) ids.push(inboxMessage({ subject: `${STAMP} burst ${i}`, from, attachments: [pdf()] }).id);
    assert.equal(m365.M365_INTAKE_LIMITS.perSender, inbound.INBOUND_LIMITS.perSender, "the pipeline's own limit, applied before the download");
    await poll();
    const all = async () => (await pool().query("SELECT message_id, state, attempts, deferrals, filed, error, extract(epoch FROM retry_at - now())::int AS wait FROM hd_m365_messages WHERE mailbox_id = $1 AND message_id = ANY($2)", [helpId, ids])).rows;
    let rows = await all();
    assert.equal(rows.filter((s) => s.state === "done").length, m365.M365_INTAKE_LIMITS.perSender);
    const late = rows.filter((s) => s.state === "failed");
    assert.equal(late.length, 2);
    for (const s of late) {
      assert.deepEqual([s.attempts, s.deferrals, s.filed], [0, 1, false]);
      assert.match(s.error, /^Too many messages from this sender\. It is tried again later\.$/);
      assert.ok(s.wait > 100 && s.wait <= 120, `tried again in about two minutes (${s.wait} s)`);
      assert.deepEqual(kind(s.message_id), { head: 1, body: 0, attachments: 0, mime: 0 }, "nothing of it was downloaded");
      assert.equal(fake.mailboxes.get(HELP)!.messages.get(s.message_id)!.isRead, false, "left unread until it is taken in");
    }
    const view = (await m365.m365MailView()).mailboxes.find((m) => m.id === helpId)!;
    assert.deepEqual([view.waiting, view.failed], [2, 0]);
    // Not before its wait is over, however often the mailbox is read.
    fresh();
    await poll();
    assert.equal((await all()).filter((s) => s.state === "failed").length, 2);
    // The wait is over: the next tick reads the mailbox for it, although neither the timer nor a notification asks.
    await pool().query("UPDATE hd_m365_messages SET retry_at = now() - interval '1 second' WHERE mailbox_id = $1 AND message_id = ANY($2) AND state = 'failed'", [helpId, ids]);
    await pool().query("UPDATE hd_m365_mailboxes SET poll_due = false, last_poll_at = now()");
    await m365.m365MailSweep();
    rows = await all();
    assert.equal(rows.filter((s) => s.state === "done").length, ids.length);
    assert.equal((await ticketFor(`${STAMP} burst ${ids.length - 1}`)).length, 1);
    fresh();
  });

  test("the desk-wide cap: more mail in a minute than the webhook would take is put off, not downloaded", async () => {
    fresh();
    assert.equal(m365.M365_INTAKE_LIMITS.perMinute, inbound.INBOUND_LIMITS.perMinute, "the webhook's own number");
    const n = m365.M365_INTAKE_LIMITS.perMinute + 4;
    const ids = Array.from({ length: n }, (_, i) => inboxMessage({ subject: `${STAMP} flood ${i}`, senderHeaders: [["Auto-Submitted", "auto-generated"]] }).id);
    await poll();
    const all = async () => (await pool().query("SELECT message_id, state, attempts, deferrals, error FROM hd_m365_messages WHERE mailbox_id = $1 AND message_id = ANY($2)", [helpId, ids])).rows;
    let rows = await all();
    assert.equal(rows.filter((s) => s.state === "done").length, m365.M365_INTAKE_LIMITS.perMinute);
    const late = rows.filter((s) => s.state === "failed");
    assert.equal(late.length, 4);
    for (const s of late) {
      assert.deepEqual([s.attempts, s.deferrals], [0, 1]);
      assert.match(s.error, /taking in a lot of mail right now/);
      assert.deepEqual(kind(s.message_id), { head: 1, body: 0, attachments: 0, mime: 0 });
    }
    fresh();
    await pool().query("UPDATE hd_m365_messages SET retry_at = now() - interval '1 second' WHERE mailbox_id = $1 AND message_id = ANY($2) AND state = 'failed'", [helpId, ids]);
    await poll();
    rows = await all();
    assert.equal(rows.filter((s) => s.state === "done").length, n);
    fresh();
  });

  test("at most three messages are worked at once, however many notifications arrive together", async () => {
    fresh();
    await m365.m365MailSweep();
    const msgs = Array.from({ length: 9 }, (_, i) => inboxMessage({ subject: `${STAMP} together ${i}` }));
    fake.delayMs = 40;
    fake.maxInflight = 0;
    const statuses = await Promise.all(msgs.map((m) => fake.deliver(HELP, m.id)));
    await settled();
    fake.delayMs = 0;
    assert.deepEqual([...new Set(statuses)], [202]);
    assert.ok(fake.maxInflight >= 2 && fake.maxInflight <= m365.M365_INTAKE_LIMITS.concurrent, `${fake.maxInflight} at once`);
    for (const m of msgs) assert.equal((await seen(m.id)).outcome, "created", m.subject);
    for (const m of msgs) await ticketFor(m.subject);
  });
});

// --- 1.20.7 security review: retry accounting ---------------------------------------------------

describe("a message that cannot be taken in", () => {
  const due = (id: string) => pool().query("UPDATE hd_m365_messages SET retry_at = now() - interval '1 second' WHERE mailbox_id = $1 AND message_id = $2", [helpId, id]);
  const state = async (id: string) =>
    (await pool().query("SELECT state, attempts, deferrals, error, extract(epoch FROM retry_at - updated_at)::int AS wait FROM hd_m365_messages WHERE mailbox_id = $1 AND message_id = $2", [helpId, id])).rows[0];
  const viewOf = async () => (await m365.m365MailView()).mailboxes.find((m) => m.id === helpId)!;

  before(() => {
    m365.resetM365NotifyLimitsForTests();
    inbound.resetInboundRateLimitsForTests();
  });

  test("refused outright by Microsoft: tried five times, then left alone, counted, shown and audited; Try again starts it over", async () => {
    fake.fail.message = 400;
    const m = inboxMessage({ subject: `${STAMP} unreadable` });
    for (let i = 1; i <= shared.M365_MAIL_LIMITS.attempts; i++) {
      await poll();
      const s = await state(m.id);
      assert.deepEqual([s.state, s.attempts, s.deferrals, s.wait], ["failed", i, 0, null]);
    }
    const r = await row();
    assert.equal(r.last_error, "1 message could not be taken in. It is still in the Inbox, unread. Press Try again, or open it in Outlook.");
    assert.deepEqual([(await viewOf()).failed, (await viewOf()).waiting], [1, 0]);
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, false, "left exactly as it was");
    const a = (await audits("helpdesk.m365.intake_failed")).at(-1)!;
    assert.deepEqual([a.details.address, a.details.attempts, a.actor_name], [HELP, 5, "Microsoft 365 mail"]);
    assert.match(a.details.error, /refused to read a message \(error 400/);
    // No sixth try, however often the mailbox is read.
    const gets = fake.calls(`/messages/${encodeURIComponent(m.id)}`).length;
    await poll();
    await m365.m365MailSweep();
    assert.equal(fake.calls(`/messages/${encodeURIComponent(m.id)}`).length, gets);
    assert.equal((await ticketFor(`${STAMP} unreadable`)).length, 0);

    // "Try again" on the page: the count starts over and the mailbox is read at once. Still refused: one try used.
    const again = await call(retryRoute.POST, req(`${API}/mailboxes/${helpId}/retry`, U.manager, {}), { id: String(helpId) });
    assert.deepEqual([again.status, again.body.retried, again.body.ok], [200, 1, true]);
    assert.deepEqual([(await state(m.id)).state, (await state(m.id)).attempts], ["failed", 1]);
    const mine = again.body.view.mailboxes.find((x: { id: number }) => x.id === helpId);
    assert.deepEqual([mine.failed, mine.waiting], [0, 1]);
    assert.deepEqual((await audits("helpdesk.m365.retry_requested")).at(-1)!.details, { address: HELP, messages: 1 });
    assert.ok(auditLabels.hasActionLabel("helpdesk.m365.retry_requested"));
    // Microsoft is well again: the next read takes it in.
    fake.fail = {};
    assert.deepEqual(await poll(), { ok: true });
    assert.equal((await ticketFor(`${STAMP} unreadable`)).length, 1);
    assert.equal((await row()).last_error, "");
    // Nothing given up on: Try again is just a read, and nothing is audited.
    const n = (await audits("helpdesk.m365.retry_requested")).length;
    const none = await call(retryRoute.POST, req(`${API}/mailboxes/${helpId}/retry`, U.manager, {}), { id: String(helpId) });
    assert.deepEqual([none.status, none.body.retried], [200, 0]);
    assert.equal((await audits("helpdesk.m365.retry_requested")).length, n);
    assert.equal((await call(retryRoute.POST, req(`${API}/mailboxes/999999999/retry`, U.manager, {}), { id: "999999999" })).status, 404);
  });

  test("no answer, 'try later' and trouble with the connection itself are put off with a growing wait, and never use up a try", async () => {
    const m = inboxMessage({ subject: `${STAMP} a slow day at Microsoft` });
    // A 500, a cut connection, "too many requests", "unavailable", a sign-in and a permission problem, another 500.
    const waits: number[] = [];
    for (const [i, status] of [500, -1, 429, 503, 401, 403, 500].entries()) {
      fake.fail.message = status;
      if (i > 0) await due(m.id);
      await poll();
      const s = await state(m.id);
      assert.deepEqual([s.state, s.attempts, s.deferrals], ["failed", 0, i + 1], `after a ${status}`);
      waits.push(s.wait);
    }
    assert.deepEqual(waits, [60, 120, 240, 480, 960, 1800, 1800], "one minute, doubling, up to half an hour");
    assert.deepEqual([(await viewOf()).failed, (await viewOf()).waiting], [0, 1]);
    assert.equal((await row()).last_error, "", "nothing is wrong with the mailbox");
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, false);
    // Not tried before its wait is over.
    const gets = fake.calls(`/messages/${encodeURIComponent(m.id)}`).length;
    await poll();
    assert.equal(fake.calls(`/messages/${encodeURIComponent(m.id)}`).length, gets);
    // Microsoft says how long to wait (Retry-After): honoured, up to an hour.
    fake.fail.message = 429;
    fake.retryAfter = 2400;
    await due(m.id);
    await poll();
    assert.equal((await state(m.id)).wait, 2400);
    fake.retryAfter = 99_999;
    await due(m.id);
    await poll();
    assert.equal((await state(m.id)).wait, 3600);
    fake.retryAfter = 0;
    assert.equal((await state(m.id)).attempts, 0, "nine failures of this kind, and not one try used");
    assert.equal((await audits("helpdesk.m365.intake_failed")).filter((a) => /error 5|limiting requests/.test(a.details.error)).length, 0);
    // After a week of it the desk stops, says so, and Try again is there.
    await pool().query("UPDATE hd_m365_messages SET created_at = now() - interval '8 days' WHERE mailbox_id = $1 AND message_id = $2", [helpId, m.id]);
    fake.fail.message = 503;
    await due(m.id);
    await poll();
    assert.deepEqual([(await state(m.id)).attempts, (await viewOf()).failed], [shared.M365_MAIL_LIMITS.attempts, 1]);
    assert.match((await audits("helpdesk.m365.intake_failed")).at(-1)!.details.error, /had a problem \(error 503\)/);
    fake.fail = {};
    const again = await call(retryRoute.POST, req(`${API}/mailboxes/${helpId}/retry`, U.manager, {}), { id: String(helpId) });
    assert.deepEqual([again.body.retried, again.body.ok, again.body.error], [1, true, undefined]);
    assert.equal((await ticketFor(`${STAMP} a slow day at Microsoft`)).length, 1);
  });

  test("an attachment Microsoft does not hand over: put off twice, then the message is taken in without it and says so", async () => {
    const saved: string[] = [];
    inbound.setInboundAttachmentStoreForTests({
      save: async (i) => {
        saved.push(i.filename);
        return { id: 920000 + saved.length, filename: i.filename, mime: i.mime, size: i.buf.length } as never;
      },
      bind: async () => [],
    });
    const m = inboxMessage({
      subject: `${STAMP} a slow attachment`,
      attachments: [
        { id: "att-ok", name: "notes.txt", contentType: "text/plain", data: Buffer.from("the notes") },
        { id: "att-slow", name: "site-survey [final].pdf", contentType: "application/pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(50_000, 66)]) },
      ],
    });
    fake.fail.attachmentValue = -1; // no answer at all, as a timeout is
    fake.failAttachmentId = "att-slow";
    await poll();
    assert.deepEqual([(await state(m.id)).state, (await state(m.id)).attempts, (await state(m.id)).deferrals], ["failed", 0, 1]);
    await due(m.id);
    await poll();
    assert.deepEqual([(await state(m.id)).attempts, (await state(m.id)).deferrals], [0, 2]);
    assert.equal((await ticketFor(`${STAMP} a slow attachment`)).length, 0, "not yet: Microsoft may hand it over next time");
    // The third time it is still not handed over: the message is not held back any longer.
    await due(m.id);
    assert.deepEqual(await poll(), { ok: true });
    const [t] = await ticketFor(`${STAMP} a slow attachment`);
    assert.ok(t, "taken in");
    assert.equal((await seen(m.id)).outcome, "created");
    assert.deepEqual(saved, ["notes.txt"], "what could be fetched was");
    const notes = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND via = 'system' ORDER BY id", [t.id])).rows.map((x) => x.body).join("\n---\n");
    assert.match(notes, /1 attachment could not be fetched from Microsoft 365 in time and was not added:\n\n- site-survey _final_\.pdf\n\nThe email is still in the mailbox with it\./);
    assert.equal(fake.mailboxes.get(HELP)!.messages.get(m.id)!.isRead, true);
    fake.fail = {};
    fake.failAttachmentId = "";
    inbound.setInboundAttachmentStoreForTests(null);
  });
});

// --- 1.20.7 security review: meeting invites (the 1.20.6 invite code) -------------------------------

describe("meeting invites from Exchange (eventMessage)", () => {
  const uidOf = (name: string) => `${STAMP}-${name}@calendar.example.test`;
  const ics = (method: string, uid: string, lines: string[]) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN", `METHOD:${method}`, "BEGIN:VEVENT", `UID:${uid}`, ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  /** The MIME Exchange hands out for a meeting message: the invite is a text/calendar part, never an attachment. */
  const mime = (text: string, encoding: "base64" | "quoted-printable" | "8bit", method: string) => {
    const b = "----=_NextPart_000_01D8_0123ABCDEF";
    const part =
      encoding === "base64"
        ? Buffer.from(text).toString("base64").replace(/(.{76})/g, "$1\r\n")
        : encoding === "quoted-printable"
          ? text.replace(/=/g, "=3D").replace(/Boardroom/g, "Board=\r\nroom")
          : text;
    return Buffer.from(
      [
        `From: Daniel <${U.req.email}>`,
        "Subject: a meeting",
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative;\r\n\tboundary="${b}"`,
        "",
        `--${b}`,
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        "Please set the room up.",
        "",
        `--${b}`,
        `Content-Type: text/calendar; charset="utf-8"; method=${method}`,
        `Content-Transfer-Encoding: ${encoding}`,
        "",
        part,
        "",
        `--${b}--`,
        "",
      ].join("\r\n")
    );
  };
  const fromReq = () => ({ name: "Daniel", address: U.req.email });
  const eventOf = async (ticketId: number) => (await pool().query("SELECT * FROM hd_ticket_events WHERE ticket_id = $1", [ticketId])).rows[0];
  const iso = (d: Date | string) => new Date(d).toISOString();
  const mimeReads = (id: string) => fake.requests.filter((l) => l === `GET /graph/v1.0/users/${encodeURIComponent(HELP)}/messages/${encodeURIComponent(id)}/$value`).length;
  const UID = uidOf("board");

  before(() => {
    m365.resetM365NotifyLimitsForTests();
    inbound.resetInboundRateLimitsForTests();
  });

  test("the part reader: base64, quoted-printable and 8bit parts; nothing over the invite reader's own limit", () => {
    const text = ics("REQUEST", "u1", ["DTSTART:20310710T140000Z", "LOCATION:Boardroom A", "DESCRIPTION:a=b"]);
    const { ICS_LIMITS } = require("../src/lib/helpdesk/desk-calendar-ics") as typeof import("../src/lib/helpdesk/desk-calendar-ics"); // eslint-disable-line @typescript-eslint/no-require-imports
    for (const enc of ["base64", "quoted-printable", "8bit"] as const) {
      const got = message.calendarPart(mime(text, enc, "REQUEST"), ICS_LIMITS.bytes);
      assert.equal(got?.toString("utf8").trim(), text, enc);
    }
    assert.equal(message.calendarPart(Buffer.from("From: a@b.example\r\nContent-Type: text/plain\r\n\r\nContent-Type: text/calendar is only mentioned here, in the middle of a line\r\n"), ICS_LIMITS.bytes), null);
    assert.equal(message.calendarPart(Buffer.from("no mime at all"), ICS_LIMITS.bytes), null);
    const big = ics("REQUEST", "u2", ["DTSTART:20310710T140000Z", `DESCRIPTION:${"x".repeat(ICS_LIMITS.bytes + 10)}`]);
    assert.equal(message.calendarPart(mime(big, "8bit", "REQUEST"), ICS_LIMITS.bytes), null, "larger than the invite reader reads: not handed on");
    const t0 = Date.now();
    assert.equal(message.calendarPart(Buffer.from("Content-Type: text/calendar\r\n".repeat(50_000)), ICS_LIMITS.bytes), null);
    assert.ok(Date.now() - t0 < 500, "a flood of part headers costs nothing");
  });

  test("an invite becomes a ticket with its event filled in: read from the message's MIME, as the webhook's calendar field is", async () => {
    const text = ics("REQUEST", UID, ["SEQUENCE:0", "DTSTART:20310710T140000Z", "DTEND:20310710T153000Z", "SUMMARY:Board meeting", "LOCATION:Boardroom A"]);
    const m = inboxMessage({ subject: `${STAMP} Board meeting`, from: fromReq(), eventMessage: true, mime: mime(text, "base64", "REQUEST") });
    assert.deepEqual(await poll(), { ok: true });
    const [t] = await ticketFor(`${STAMP} Board meeting`);
    assert.ok(t, "the invite opened a ticket");
    assert.equal(t.requester_id, U.req.id);
    const e = await eventOf(t.id);
    assert.ok(e, "and the ticket has its event");
    assert.deepEqual([e.ics_uid, iso(e.starts_at), iso(e.ends_at), e.place, e.source, e.ics_sequence], [UID, "2031-07-10T14:00:00.000Z", "2031-07-10T15:30:00.000Z", "Boardroom A", "invite", 0]);
    assert.equal(mimeReads(m.id), 1, "the MIME was read once");
    const notes = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND via = 'system'", [t.id])).rows.map((x) => x.body).join("\n");
    assert.match(notes, /Event added from the meeting invite/);
    assert.doesNotMatch(notes, /not added from the email/, "the invite is not reported as a file that could not be added");
    // An ordinary message: its MIME is never asked for.
    const plain = inboxMessage({ subject: `${STAMP} not a meeting` });
    await poll();
    assert.equal((await seen(plain.id)).outcome, "created");
    assert.equal(mimeReads(plain.id), 0);
    await ticketFor(`${STAMP} not a meeting`);
  });

  test("an update and a cancellation, which Exchange sends as new mail, find the ticket by the meeting's UID", async () => {
    const [t] = await ticketFor(`${STAMP} Board meeting`);
    const upd = inboxMessage({
      subject: `${STAMP} Board meeting (moved)`,
      from: fromReq(),
      eventMessage: true,
      mime: mime(ics("REQUEST", UID, ["SEQUENCE:2", "DTSTART:20310711T150000Z", "DTEND:20310711T160000Z", "LOCATION:Boardroom B"]), "quoted-printable", "REQUEST"),
    });
    await poll();
    assert.equal((await seen(upd.id)).outcome, "appended");
    assert.equal((await ticketFor(`${STAMP} Board meeting (moved)`)).length, 0, "no second ticket");
    let e = await eventOf(t.id);
    assert.deepEqual([iso(e.starts_at), e.place, e.ics_sequence], ["2031-07-11T15:00:00.000Z", "Boardroom B", 2]);
    // The same UID on mail that fails the sender check is somebody's own mail: a ticket of its own, this event untouched.
    const forged = inboxMessage({
      subject: `${STAMP} hijacked meeting`,
      from: fromReq(),
      fromDomainResults: failResults("example.test"),
      eventMessage: true,
      mime: mime(ics("REQUEST", UID, ["SEQUENCE:9", "DTSTART:20350101T150000Z", "LOCATION:Nowhere"]), "8bit", "REQUEST"),
    });
    await poll();
    assert.equal((await seen(forged.id)).outcome, "created");
    assert.equal((await ticketFor(`${STAMP} hijacked meeting`)).length, 1);
    e = await eventOf(t.id);
    assert.deepEqual([e.place, e.ics_sequence], ["Boardroom B", 2]);
    // The cancellation.
    const cancel = inboxMessage({ subject: `Canceled: ${STAMP} Board meeting`, from: fromReq(), eventMessage: true, mime: mime(ics("CANCEL", UID, ["SEQUENCE:3", "DTSTART:20310711T150000Z"]), "8bit", "CANCEL") });
    await poll();
    assert.equal((await seen(cancel.id)).outcome, "appended");
    assert.ok((await eventOf(t.id)).cancelled_at, "the event is marked cancelled");
    assert.equal((await ticketFor(`Canceled: ${STAMP} Board meeting`)).length, 0);
  });

  test("limits: an invite over the reader's limit, a MIME too large to look through or one Microsoft refuses is no invite, and the mail is a ticket all the same; 'try later' is put off", async () => {
    const { ICS_LIMITS } = require("../src/lib/helpdesk/desk-calendar-ics") as typeof import("../src/lib/helpdesk/desk-calendar-ics"); // eslint-disable-line @typescript-eslint/no-require-imports
    const hugeInvite = inboxMessage({
      subject: `${STAMP} an invite too large`,
      from: fromReq(),
      eventMessage: true,
      mime: mime(ics("REQUEST", uidOf("huge"), ["DTSTART:20310801T100000Z", `DESCRIPTION:${"x".repeat(ICS_LIMITS.bytes + 10)}`]), "8bit", "REQUEST"),
    });
    const hugeMime = inboxMessage({ subject: `${STAMP} a MIME too large`, from: fromReq(), eventMessage: true, mime: Buffer.alloc(m365.M365_INTAKE_LIMITS.mimeBytes + 10, 65) });
    assert.deepEqual(await poll(), { ok: true });
    for (const m of [hugeInvite, hugeMime]) {
      assert.equal((await seen(m.id)).outcome, "created", m.subject);
      const [t] = await ticketFor(m.subject);
      assert.equal(await eventOf(t.id), undefined, m.subject);
    }
    // Microsoft refuses the MIME outright: no invite, still a ticket.
    fake.fail.mime = 404;
    const refused = inboxMessage({ subject: `${STAMP} a MIME Microsoft will not hand out`, from: fromReq(), eventMessage: true, mime: mime(ics("REQUEST", uidOf("refused"), ["DTSTART:20310801T100000Z"]), "8bit", "REQUEST") });
    await poll();
    assert.equal((await seen(refused.id)).outcome, "created");
    assert.equal(await eventOf((await ticketFor(refused.subject))[0].id), undefined);
    // "Try later": the whole message waits (not counted), and has its event when Microsoft is back.
    fake.fail.mime = 503;
    const later = inboxMessage({ subject: `${STAMP} an invite on a slow day`, from: fromReq(), eventMessage: true, mime: mime(ics("REQUEST", uidOf("later"), ["DTSTART:20310802T100000Z", "LOCATION:Room 4"]), "base64", "REQUEST") });
    await poll();
    const s = (await pool().query("SELECT state, attempts, deferrals FROM hd_m365_messages WHERE mailbox_id = $1 AND message_id = $2", [helpId, later.id])).rows[0];
    assert.deepEqual([s.state, s.attempts, s.deferrals], ["failed", 0, 1]);
    assert.equal((await ticketFor(later.subject)).length, 0);
    fake.fail = {};
    await pool().query("UPDATE hd_m365_messages SET retry_at = now() - interval '1 second' WHERE mailbox_id = $1 AND message_id = $2", [helpId, later.id]);
    await poll();
    assert.equal((await eventOf((await ticketFor(later.subject))[0].id)).place, "Room 4");
  });
});

// --- 1.20.7: the "Last messages" diagnostic -----------------------------------------------------

describe("last messages (how the sender check went)", () => {
  test("for the last messages: when, the sender's domain, the outcome of the check and what Exchange's headers said; never any content", async () => {
    m365.resetM365NotifyLimitsForTests();
    inbound.resetInboundRateLimitsForTests();
    const tag = newToken().slice(0, 8).toLowerCase();
    const secret = `private${tag}`;
    const at = (name: string) => ({ name: `Priya Secretname${tag}`, address: `priya.${tag}@${name}-${tag}.example` });
    const mk = (name: string, over: Parameters<typeof inboxMessage>[0] = {}) => inboxMessage({ subject: `${STAMP} ${secret} ${name}`, from: at(name), body: { contentType: "text", content: `the body ${secret}` }, ...over });
    mk("pass");
    mk("fail", { fromDomainResults: failResults(`fail-${tag}.example`) });
    mk("internal", { fromDomainResults: "", authAs: ["Internal"] });
    mk("none", { fromDomainResults: "", authAs: [] });
    mk("allnone", { fromDomainResults: `spf=none (sender IP is 203.0.113.9) smtp.mailfrom=allnone-${tag}.example; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=allnone-${tag}.example;compauth=none reason=405` });
    mk("twostamps", { fromDomainResults: "", authAs: ["Internal", "Internal"] });
    inboxMessage({ subject: `${STAMP} ${secret} nobody`, from: null });
    assert.deepEqual(await poll(), { ok: true });

    const r = await call(messagesRoute.GET, req(`${API}/mailboxes/${helpId}/messages`, U.manager, undefined, "GET"), { id: String(helpId) });
    assert.equal(r.status, 200);
    const list = r.body.messages as { at: string; sender_domain: string; check: string; reason: string; outcome: string }[];
    assert.ok(list.length >= 7 && list.length <= 12, "the last few, not the whole history");
    for (const m of list) assert.deepEqual(Object.keys(m).sort(), ["at", "check", "outcome", "reason", "sender_domain"]);
    assert.ok(list.every((m, i) => i === 0 || Date.parse(list[i - 1].at) >= Date.parse(m.at)), "newest first");
    const of = (name: string) => list.find((m) => m.sender_domain === `${name}-${tag}.example`)!;
    assert.deepEqual([of("pass").check, of("pass").outcome], ["passed", "created"]);
    assert.equal(of("pass").reason, "AuthAs stamp: anonymous; first of 1 Authentication-Results: spf=pass, dkim=pass, dmarc=pass, compauth=pass (reason 100)");
    assert.equal(of("fail").check, "failed");
    assert.match(of("fail").reason, /^AuthAs stamp: anonymous; first of 1 Authentication-Results: spf=fail, dkim=none, dmarc=fail, compauth=fail \(reason 000\); \S/);
    assert.deepEqual([of("internal").check, of("internal").reason], ["internal", "AuthAs stamp: internal; no Authentication-Results header"]);
    assert.deepEqual([of("none").check, of("none").reason], ["none", "no AuthAs stamp; no Authentication-Results header"]);
    // Results that are all "none" read as a failed check, and the line shows why.
    assert.equal(of("allnone").check, "failed");
    assert.match(of("allnone").reason, /spf=none, dkim=none, dmarc=none, compauth=none \(reason 405\)/);
    // Two Internal stamps are not Exchange's one: the line shows what was there.
    assert.deepEqual([of("twostamps").check, of("twostamps").reason], ["none", "AuthAs stamp: internal, internal (2 headers); no Authentication-Results header"]);
    const nobody = list.find((m) => m.sender_domain === "" && m.outcome === "skipped_no_sender")!;
    assert.deepEqual([nobody.check, nobody.reason], ["", "No sender address on the message."]);
    // No content: no subject, no address, no name, no text.
    const text = JSON.stringify(r.body);
    for (const leak of [secret, "priya", "Secretname", "@"]) assert.ok(!text.includes(leak), `"${leak}" is not in the answer`);
    const kept = (await pool().query("SELECT sender_domain, sender_reason FROM hd_m365_messages WHERE mailbox_id = $1", [helpId])).rows;
    for (const k of kept) assert.ok(!/@/.test(k.sender_domain + k.sender_reason) && !k.sender_reason.includes(secret), JSON.stringify(k));
    // Unknown mailbox: 404. It only reads.
    assert.equal((await call(messagesRoute.GET, req(`${API}/mailboxes/999999999/messages`, U.manager, undefined, "GET"), { id: "999999999" })).status, 404);
    assert.equal((await call(messagesRoute.GET, req(`${API}/mailboxes/x/messages`, U.manager, undefined, "GET"), { id: "x" })).status, 404);
    for (const name of ["pass", "fail", "internal", "none", "allnone", "twostamps"]) await ticketFor(`${STAMP} ${secret} ${name}`);
  });
});

// --- Corrections from Microsoft's documentation: how a mailbox is named -----------------------------

describe("a mailbox Microsoft does not find by its address", () => {
  const SHARED = `frontdesk@${DOMAIN}`;
  const UPN = `frontdesk_shared@${STAMP}.onmicrosoft.example`;
  const OHARA = `o'hara@${DOMAIN}`;
  let oid = "";
  let sharedId = 0;
  let oharaId = 0;
  const subFor = (address: string) => [...fake.subscriptions.values()].find((s) => s.mailbox === address);
  const patch = (id: number, graph_id: unknown) => call(boxRoute.PATCH, req(`${API}/mailboxes/${id}`, U.manager, { graph_id }, "PATCH"), { id: String(id) });

  before(() => {
    m365.resetM365NotifyLimitsForTests();
    inbound.resetInboundRateLimitsForTests();
    oid = fake.addMailbox(SHARED, "shared", { upn: UPN }).objectId;
    fake.addMailbox(OHARA, "shared");
    for (const a of [SHARED, OHARA]) {
      app.scope.add(a);
      app.sendScope.add(a);
    }
  });

  test("by the address alone it is refused, with where to enter its object ID; with the object ID it connects, and every call names the mailbox by it", async () => {
    const no = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: SHARED }));
    assert.deepEqual([no.status, no.body.code], [422, "not_a_mailbox"]);
    assert.match(no.body.error, /If the mailbox's sign-in name is not this address, enter its object ID or sign-in name under Advanced\.$/);
    const mark = fake.requests.length;
    const yes = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: SHARED, graph_id: ` ${oid.toUpperCase()} ` }));
    assert.equal(yes.status, 201, JSON.stringify(yes.body));
    sharedId = yes.body.mailbox.id;
    assert.equal(yes.body.view.mailboxes.find((m: { id: number }) => m.id === sharedId).graph_id, oid);
    assert.equal((await audits("helpdesk.m365.mailbox_connected")).at(-1)!.details.graph_id, oid);
    // A help address lives on it (an alias here), so it is read; and its replies go out through it.
    await m365.setM365AddressLink(boxBilling.id, { m365_mailbox_id: sharedId, send_via: true }, by());
    const m = inboxMessage({ subject: `${STAMP} to the front desk`, to: [{ name: "", address: BILLING }] }, SHARED);
    await m365.m365MailSweep();
    assert.equal((await seen(m.id, sharedId)).outcome, "created");
    const [t] = await ticketFor(`${STAMP} to the front desk`);
    assert.equal(t.mailbox_id, boxBilling.id);
    assert.equal(fake.mailboxes.get(SHARED)!.messages.get(m.id)!.isRead, true);
    // The subscription's resource too (what Microsoft recommends), created with immutable ids.
    const sub = subFor(SHARED)!;
    assert.equal(sub.resource, `users/${oid}/mailFolders('inbox')/messages`);
    assert.match(sub.prefer, /IdType="ImmutableId"/);
    assert.equal(await m365Send.sendThroughM365(boxBilling.id, BILLING, "Acme Billing", { to: "cara@customer.example", from: BILLING, subject: `${STAMP} from the front desk`, text: "Hello", html: "<p>Hello</p>", headers: {} }), "sent");
    // (The new ticket's acknowledgement went out the same way: the one sent here is among them.)
    assert.ok(fake.mailboxes.get(SHARED)!.sent.some((x) => x.toString("utf8").replace(/\r?\n[ \t]+/g, " ").includes(`${STAMP} from the front desk`)));
    const mine = fake.requests.slice(mark).filter((l) => l.includes("/users/") && (l.includes(oid) || l.includes(encodeURIComponent(SHARED))));
    assert.ok(mine.length >= 6, "the probe, the delta read, the message, the mark, the send");
    for (const l of mine) assert.ok(l.includes(`/users/${oid}/`), `by the object ID: ${l}`);
    assert.ok(mine.some((l) => l.startsWith(`POST /graph/v1.0/users/${oid}/sendMail`)));
    // The commands' test line names the mailbox by its object ID when the desk has it.
    const v = await m365.m365MailView();
    const text = shared.restrictCommands({ clientId: v.client_id, spObjectId: v.sp_object_id, addresses: [SHARED], first: false, graphIds: { [SHARED]: v.mailboxes.find((x) => x.id === sharedId)!.graph_id } })!;
    assert.ok(text.includes(`-Resource '${oid}' | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope`));
  });

  test("the lookup can be changed later; a value that names no mailbox is refused and nothing changes", async () => {
    assert.equal((await patch(sharedId, "$(whoami)")).status, 400);
    const none = await patch(sharedId, "11111111-2222-3333-4444-555555555555");
    assert.deepEqual([none.status, none.body.code], [422, "not_a_mailbox"]);
    const empty = await patch(sharedId, "");
    assert.equal(empty.status, 422, "by its address alone Microsoft still does not find it");
    assert.match(empty.body.error, /enter its object ID or sign-in name under Advanced/);
    assert.equal((await row(sharedId)).graph_id, oid);
    assert.ok(subFor(SHARED), "and its subscription is still there");
    // Its sign-in name works too. The subscription named the old value, so it goes; the next tick makes a new one.
    const upn = await patch(sharedId, UPN.toUpperCase());
    assert.deepEqual([upn.status, upn.body.graph_id], [200, UPN]);
    assert.equal(subFor(SHARED), undefined);
    assert.deepEqual((await audits("helpdesk.m365.mailbox_changed")).at(-1)!.details, { address: SHARED, graph_id: UPN, was: oid });
    assert.ok(auditLabels.hasActionLabel("helpdesk.m365.mailbox_changed"));
    await m365.m365MailSweep();
    assert.equal(subFor(SHARED)!.resource, `users/${UPN}/mailFolders('inbox')/messages`);
    // Nothing is taken in twice by the fresh start of the delta read.
    assert.equal((await ticketFor(`${STAMP} to the front desk`)).length, 1);
    assert.equal((await patch(999999999, oid)).status, 404);
  });

  test("Microsoft's 503 when a subscription is made points at the object ID field; an address with an apostrophe gets no subscription until it has one", async () => {
    // "Mailbox info is stale": Microsoft's advice for it is to name the mailbox by its object ID.
    fake.subscriptions.delete(subFor(SHARED)!.id);
    await pool().query("UPDATE hd_m365_mailboxes SET sub_id = '', sub_state = '', sub_expires_at = NULL WHERE id = $1", [sharedId]);
    fake.fail.subscriptions = 503;
    await m365.m365MailSweep();
    assert.equal((await row(sharedId)).sub_error, "Microsoft 365 could not look this mailbox up for notifications (error 503). If this keeps happening, enter the mailbox's object ID under Advanced: Microsoft recommends it for notifications.");
    assert.equal((await m365.m365MailView()).mailboxes.find((m) => m.id === sharedId)!.mode, "timer_refused");
    fake.fail = {};
    assert.equal((await patch(sharedId, oid)).status, 200);

    const made = await call(boxesRoute.POST, req(`${API}/mailboxes`, U.manager, { address: OHARA }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    oharaId = made.body.mailbox.id;
    await m365.setM365AddressLink(boxBilling.id, { m365_mailbox_id: oharaId, send_via: false }, by());
    const posts = fake.calls("POST /graph/v1.0/subscriptions").length;
    const m = inboxMessage({ subject: `${STAMP} to O'Hara`, to: [{ name: "", address: BILLING }] }, OHARA);
    await m365.m365MailSweep();
    assert.match((await row(oharaId)).sub_error, /^An address with an apostrophe can't be named in a notification subscription\. Enter the mailbox's object ID under Advanced\./);
    assert.equal(subFor(OHARA), undefined);
    // (The front desk has no help address any more, so it is idle and asks for nothing.)
    assert.equal(fake.calls("POST /graph/v1.0/subscriptions").length, posts, "Microsoft was not asked for a subscription it could not name");
    assert.equal((await seen(m.id, oharaId)).outcome, "created", "the timer reads it meanwhile");
    assert.equal((await patch(oharaId, fake.mailboxes.get(OHARA)!.objectId)).status, 200);
    await m365.m365MailSweep();
    assert.equal(subFor(OHARA)!.resource, `users/${fake.mailboxes.get(OHARA)!.objectId}/mailFolders('inbox')/messages`);
    await ticketFor(`${STAMP} to O'Hara`);
  });

  after(async () => {
    // As the rest of the file found things: billing@ is an alias on the help mailbox, and only help@ and sales@ are connected.
    await m365.setM365AddressLink(boxBilling.id, { m365_mailbox_id: helpId, send_via: false }, by());
    for (const id of [sharedId, oharaId]) if (id) await m365.disconnectM365Mailbox(id, by());
    for (const a of [SHARED, OHARA]) {
      app.scope.delete(a);
      app.sendScope.delete(a);
    }
  });
});

// --- 1.20.7 security review: the connection changes hands ---------------------------------------------

describe("the connection changes hands", () => {
  before(() => {
    fake.fail = {};
  });
  const connectAgain = () => m365.saveM365Connection({ tenant: fake.tenantId, client_id: app.appId, secret: app.secrets[0] }, by());

  test("another app registration: the old app's subscriptions are deleted at Microsoft before they are forgotten", async () => {
    await m365.m365MailSweep();
    const olds = [...fake.subscriptions.values()].map((s) => s.id);
    assert.equal(olds.length, 2);
    const other = fake.addApp();
    other.scope = new Set(app.scope);
    other.sendScope = new Set(app.sendScope);
    const keyBefore = (await cfg()).notify_key;
    const r = await m365.saveM365Connection({ tenant: fake.tenantId, client_id: other.appId, secret: other.secrets[0] }, by());
    assert.equal(r.created, false);
    assert.equal(fake.subscriptions.size, 0, "nothing of the old app's is left at Microsoft to keep posting");
    for (const id of olds) assert.equal(fake.calls(`DELETE /graph/v1.0/subscriptions/${id} 204`).length, 1, id);
    const rows = (await pool().query("SELECT sub_id, sub_state, poll_due FROM hd_m365_mailboxes ORDER BY id")).rows;
    assert.deepEqual(rows, [{ sub_id: "", sub_state: "", poll_due: true }, { sub_id: "", sub_state: "", poll_due: true }]);
    assert.equal((await cfg()).notify_key, keyBefore, "the same connection goes on under the new app");
    await m365.m365MailSweep();
    assert.deepEqual([...new Set([...fake.subscriptions.values()].map((s) => s.appId))], [other.appId]);
    // Back to the app the rest of the file uses.
    await connectAgain();
    other.deleted = true;
    await m365.m365MailSweep();
    assert.deepEqual([...new Set([...fake.subscriptions.values()].map((s) => s.appId))], [app.appId]);
  });

  test("removing the connection rotates the notification key: the old address answers nobody, the next connection gets a new one", async () => {
    const oldKey = (await cfg()).notify_key;
    const hello = (k: string) => m365.handleM365Notification(new Request("http://localhost/x?validationToken=hello", { method: "POST" }), k, { ip: "198.51.100.40" });
    assert.deepEqual(await hello(oldKey), { status: 200, text: "hello" });
    assert.equal(await m365.removeM365Connection(by()), true);
    assert.equal(fake.subscriptions.size, 0);
    assert.equal((await cfg()).notify_key, "");
    assert.equal((await hello(oldKey)).status, 404);
    assert.equal((await hello("")).status, 404);
    assert.deepEqual([(await m365.m365MailView()).tenant_wide, (await m365.m365MailView()).tenant_wide_at], [[], null]);
    await connectAgain();
    const newKey = (await cfg()).notify_key;
    assert.ok(newKey.length >= 32 && newKey !== oldKey);
    assert.equal((await hello(oldKey)).status, 404, "the old key stays dead");
    assert.deepEqual(await hello(newKey), { status: 200, text: "hello" });
    await m365.m365MailSweep();
    assert.equal(fake.subscriptions.size, 2);
    for (const s of fake.subscriptions.values()) assert.ok(s.notificationUrl.endsWith(`/${newKey}`));
  });

  test("two one-click saves at the same moment: one is stored whole, the other is told the desk is already connected", async () => {
    await m365.removeM365Connection(by());
    const a = fake.addApp();
    const b = fake.addApp();
    const save = (x: FakeApp) => m365.saveM365Connection({ tenant: fake.tenantId, client_id: x.appId, secret: x.secrets[0] }, by(), { setup: "one_click", tenantId: fake.tenantId, spObjectId: x.spId });
    const results = await Promise.allSettled([save(a), save(b)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.deepEqual([won.length, lost.length], [1, 1]);
    assert.deepEqual([lost[0].reason.status, lost[0].reason.code], [409, "already_connected"]);
    const winner = results[0].status === "fulfilled" ? a : b;
    const c = await cfg();
    assert.deepEqual([c.client_id, c.secret, c.sp_object_id], [winner.appId, winner.secrets[0], winner.spId]);
    // And afterwards, plainly: a one-click save never replaces a saved connection.
    await assert.rejects(save(results[0].status === "fulfilled" ? b : a), (e: Error & { code?: string }) => e.code === "already_connected");
    assert.equal((await cfg()).client_id, winner.appId);
    a.deleted = true;
    b.deleted = true;
    await m365.removeM365Connection(by());
    await connectAgain();
    await m365.m365MailSweep();
    assert.equal(fake.subscriptions.size, 2);
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

  test("permissions: a session, and the Helpdesk settings capability (the Email channel capability alone is not enough)", async () => {
    assert.equal((await call((r: Request) => setup.m365MailSetupHandler("POST", ["start"], r), req("http://localhost/x", null, {}))).status, 401);
    assert.equal((await call((r: Request) => setup.m365MailSetupHandler("POST", ["start"], r), req("http://localhost/x", U.agent, {}))).status, 403);
    assert.equal((await pollSetup("whatever", U.agent)).status, 403);
    deskRoles.setRoleMatrixForTests({ ...rolesShared.HD_DEFAULT_MATRIX, team_lead: [...rolesShared.HD_DEFAULT_MATRIX.team_lead, "channels.manage"] });
    try {
      assert.equal((await call(rootRoute.GET, req(API, U.lead, undefined, "GET"))).status, 200, "this person may open the Email settings");
      assert.equal((await call((r: Request) => setup.m365MailSetupHandler("POST", ["start"], r), req("http://localhost/x", U.lead, {}))).status, 403);
      assert.equal((await pollSetup("whatever", U.lead)).status, 403);
    } finally {
      deskRoles.setRoleMatrixForTests(null);
    }
    assert.equal((await pollSetup("whatever")).status, 410);
  });

  test("the setup's own sign-in and Graph addresses can be pointed at a loopback test rig only", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const device = require("../ee/ms-device-setup") as { deviceSetupBases: () => { login: string; graph: string } };
    const keep = [process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE, process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE];
    assert.deepEqual(device.deviceSetupBases(), { login: `${fake.base}/login`, graph: `${fake.base}/graph` });
    // Anything that is not plain http on 127.0.0.1 or localhost is ignored: an admin's sign-in and token go to Microsoft only.
    for (const off of ["https://login.attacker.example", "http://10.0.0.5:4000/login", "http://127.0.0.1.evil.example:4000", "https://127.0.0.1:4000", "http://127.0.0.1:4000@evil.example/login", "http://localhost:4000/../x", "http://[::1]:4000", "//evil.example", "evil.example"]) {
      process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE = off;
      process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE = off;
      assert.deepEqual(device.deviceSetupBases(), { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" }, off);
    }
    process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE = "http://localhost:4871/login/";
    assert.equal(device.deviceSetupBases().login, "http://localhost:4871/login");
    delete process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE;
    delete process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE;
    assert.deepEqual(device.deviceSetupBases(), { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" });
    [process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE, process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE] = keep;
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
    // Two admins finish the setup at the same moment: one app is saved, the other is taken out of Entra again.
    const s1 = await start();
    const s2 = await start();
    fake.failStep = "";
    assert.deepEqual((await pollSetup(s1.body.setup_id)).body, { status: "pending" });
    assert.deepEqual((await pollSetup(s2.body.setup_id)).body, { status: "pending" });
    const both = await Promise.all([pollSetup(s1.body.setup_id), pollSetup(s2.body.setup_id)]);
    assert.deepEqual(both.map((b) => b.status).sort(), [200, 502]);
    assert.match(both.find((b) => b.status === 502)!.body.error, /(already connected\. To make a new app registration, remove the connection first\.|changed by someone else at the same moment\. Nothing was saved\. Look at the page again\.) The new app registration was removed from Entra again\./);
    assert.equal(live().length, 1, "one app registration is left in Entra: the saved one");
    assert.equal((await cfg()).client_id, live()[0].appId);
    await m365.removeM365Connection(by());
    for (const a of live()) a.deleted = true;
    fake.failStep = "servicePrincipals";
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
    const oneClick = { setup: "one_click" as const, tenantId: fake.tenantId, spObjectId: pending.spId, secretExpires: "2028-11-12", verify: false };
    // While a connection is saved the one-click save is refused inside the save itself, whatever the setup's own check saw.
    await assert.rejects(m365.saveM365Connection({ tenant: fake.tenantId, client_id: pending.appId, secret: pending.secrets[0] }, by(), oneClick), (e: Error & { status?: number; code?: string }) => e.status === 409 && e.code === "already_connected");
    await m365.removeM365Connection(by());
    await assert.rejects(m365.saveM365Connection({ tenant: "contoso.example", client_id: pending.appId, secret: pending.secrets[0] }, by(), { setup: "one_click", tenantId: fake.tenantId, verify: false }), /must be the ID of the tenant it was created in/);
    const r = await m365.saveM365Connection({ tenant: fake.tenantId, client_id: pending.appId, secret: pending.secrets[0] }, by(), oneClick);
    assert.deepEqual([r.verified, (await cfg()).verified, (await cfg()).sp_object_id], [false, false, pending.spId]);
    assert.deepEqual(r.tenant_wide, [], "nothing is known about its token yet");
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
  // "settings": which Microsoft 365 app the desk signs in as and which mailboxes it reads (settings.manage).
  // "channels": everything else on the Email settings page (channels.manage; settings.manage covers it).
  const routes = (): [string, "settings" | "channels", () => Request, Handler, Record<string, string>][] => [
    ["GET view", "channels", () => req(API, null, undefined, "GET"), rootRoute.GET, {}],
    ["PUT connection", "settings", () => req(API, null, { tenant: fake.tenantId, client_id: app.appId, secret: "x" }, "PUT"), rootRoute.PUT, {}],
    ["PATCH options", "channels", () => req(API, null, { poll_minutes: 5 }, "PATCH"), rootRoute.PATCH, {}],
    ["DELETE connection", "settings", () => req(API, null, undefined, "DELETE"), rootRoute.DELETE, {}],
    ["POST check-access", "channels", () => req(`${API}/check-access`, null, {}), accessRoute.POST, {}],
    ["POST mailbox", "settings", () => req(`${API}/mailboxes`, null, { address: OTHER, confirm_tenant_wide: true }), boxesRoute.POST, {}],
    ["DELETE mailbox", "settings", () => req(`${API}/mailboxes/${helpId}`, null, undefined, "DELETE"), boxRoute.DELETE, { id: String(helpId) }],
    ["PATCH mailbox lookup", "settings", () => req(`${API}/mailboxes/${helpId}`, null, { graph_id: "" }, "PATCH"), boxRoute.PATCH, { id: String(helpId) }],
    ["POST check now", "channels", () => req(`${API}/mailboxes/${helpId}/check`, null, {}), checkRoute.POST, { id: String(helpId) }],
    ["POST try again", "channels", () => req(`${API}/mailboxes/${helpId}/retry`, null, {}), retryRoute.POST, { id: String(helpId) }],
    ["GET last messages", "channels", () => req(`${API}/mailboxes/${helpId}/messages`, null, undefined, "GET"), messagesRoute.GET, { id: String(helpId) }],
    ["PUT address link", "channels", () => req(`${API}/addresses/${boxHelp.id}`, null, { m365_mailbox_id: null }, "PUT"), linkRoute.PUT, { id: String(boxHelp.id) }],
  ];
  const as = (r: Request, who: Person) => {
    const h = new Headers(r.headers);
    h.set("cookie", `compass_session=${who.session}`);
    return new Request(r.url, { method: r.method, headers: h, body: r.method === "GET" || r.method === "DELETE" ? undefined : r.body, duplex: "half" } as RequestInit);
  };
  const snapshot = async () => JSON.stringify([await m365.m365MailView(), await getSetting(KEY), (await pool().query("SELECT id, address, graph_id FROM hd_m365_mailboxes ORDER BY id")).rows]);

  test("no session: 401. A requester, an agent: 403. Unlicensed: 402. Nothing changes.", async () => {
    const before = await snapshot();
    for (const [name, , make, handler, params] of routes()) {
      assert.equal((await call(handler, make(), params)).status, 401, name);
      for (const who of [U.req, U.agent, U.outsider, U.lead]) assert.equal((await call(handler, as(make(), who), params)).status, 403, `${name} as ${who.name}`);
      licensed = false;
      assert.equal((await call(handler, as(make(), U.manager), params)).status, 402, `${name} unlicensed`);
      licensed = true;
    }
    assert.equal(await snapshot(), before);
  });

  test("the Email channel capability alone: the page and its day-to-day controls, but never the connection or which mailboxes are read", async () => {
    // A desk role that was given "Email channel" and not "Helpdesk settings".
    deskRoles.setRoleMatrixForTests({ ...rolesShared.HD_DEFAULT_MATRIX, team_lead: [...rolesShared.HD_DEFAULT_MATRIX.team_lead, "channels.manage"] });
    try {
      const before = await snapshot();
      const connects = (await audits("helpdesk.m365.mailbox_connected")).length;
      const asked = fake.calls(encodeURIComponent(OTHER)).length;
      for (const [name, needs, make, handler, params] of routes()) {
        if (needs !== "settings") continue;
        const r = await call(handler, as(make(), U.lead), params);
        assert.equal(r.status, 403, `${name} with channels.manage only`);
      }
      assert.equal(await snapshot(), before, "nothing was saved, connected, changed or removed");
      assert.equal((await audits("helpdesk.m365.mailbox_connected")).length, connects);
      assert.equal(fake.calls(encodeURIComponent(OTHER)).length, asked, "Microsoft was never even asked for the other mailbox");
      // What that capability does allow: reading the page, a check, the diagnostic.
      assert.equal((await call(rootRoute.GET, as(req(API, null, undefined, "GET"), U.lead))).status, 200);
      assert.equal((await call(messagesRoute.GET, as(req(`${API}/mailboxes/${helpId}/messages`, null, undefined, "GET"), U.lead), { id: String(helpId) })).status, 200);
      assert.equal((await call(checkRoute.POST, as(req(`${API}/mailboxes/${helpId}/check`, null, {}), U.lead), { id: String(helpId) })).status, 200);
      assert.equal((await call(retryRoute.POST, as(req(`${API}/mailboxes/${helpId}/retry`, null, {}), U.lead), { id: String(helpId) })).status, 200);
      assert.equal((await call(accessRoute.POST, as(req(`${API}/check-access`, null, {}), U.lead))).status, 200);
    } finally {
      deskRoles.setRoleMatrixForTests(null);
    }
  });

  test("every admin route is behind the desk gate that also holds the Duo desk rule; the view never carries a secret; GET writes nothing", async () => {
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
    assert.equal(files.length, 8);
    const gates: Record<string, string> = {};
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const rel = path.relative(root, f);
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\) \{\n([^\n]+)\n([^\n]+)/g)];
      assert.ok(handlers.length >= 1, f);
      for (const h of handlers) {
        const gate = h[2].match(/^  const gate = await (hdAnyCapGate\(CAPS\)|hdCapGate\("settings\.manage"\));$/);
        assert.ok(gate, `${rel} ${h[1]}: ${h[2]}`);
        assert.match(h[3], /if \(gate instanceof NextResponse\) return gate;/, `${rel} ${h[1]}`);
        gates[`${h[1]} ${rel}`] = gate![1].startsWith("hdCapGate") ? "settings" : "channels";
      }
      if (src.includes("hdAnyCapGate")) assert.match(src, /const CAPS: HdCap\[\] = \["settings\.manage", "channels\.manage"\];/);
    }
    assert.deepEqual(gates, {
      "GET route.ts": "channels",
      "PUT route.ts": "settings",
      "PATCH route.ts": "channels",
      "DELETE route.ts": "settings",
      "POST check-access/route.ts": "channels",
      "POST mailboxes/route.ts": "settings",
      "DELETE mailboxes/[id]/route.ts": "settings",
      "PATCH mailboxes/[id]/route.ts": "settings",
      "POST mailboxes/[id]/check/route.ts": "channels",
      "POST mailboxes/[id]/retry/route.ts": "channels",
      "GET mailboxes/[id]/messages/route.ts": "channels",
      "PUT addresses/[id]/route.ts": "channels",
    });
    const stored = await getSetting(KEY);
    const rolesStored = await getSetting(`${KEY}_roles`);
    const view = await call(rootRoute.GET, req(API, U.manager, undefined, "GET"));
    assert.equal(view.status, 200);
    assert.deepEqual([await getSetting(KEY), await getSetting(`${KEY}_roles`)], [stored, rolesStored], "looking writes nothing");
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
    for (const a of ["connection_saved", "connection_removed", "settings_changed", "mailbox_connected", "mailbox_disconnected", "mailbox_changed", "address_changed", "access_checked", "subscription_failed", "intake_failed", "retry_requested", "tenant_wide_changed", "send_refused"]) {
      assert.ok(auditLabels.hasActionLabel(`helpdesk.m365.${a}`), a);
      assert.ok(actions.has(`helpdesk.m365.${a}`), `${a} was written`);
    }
    // Every action written has a label (none was added without one).
    for (const a of actions) assert.ok(auditLabels.hasActionLabel(a), a);
    const all = JSON.stringify(rows);
    for (const a of fake.apps.values()) for (const s of a.secrets) assert.ok(!all.includes(s));
    assert.ok(!all.includes((await cfg()).notify_key));
  });
});

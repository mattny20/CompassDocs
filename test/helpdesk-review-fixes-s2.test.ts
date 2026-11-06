// Helpdesk 1.19.0 review fixes, fixer S2 (inbound email and machine intake):
//   #5  the inbound webhook path only for channels.manage / settings.manage
//   #7  inbound bodies: everything escaped, links written by us
//   #8  alert descriptions rebuilt from an allowlist; link targets encoded
//   #9  human mail: the From address counts only with an authenticated
//       sender (or the trust setting when no verdict); never into a ticket
//       unverified
//   #10 machine mail: fail closed without a verdict unless the integration
//       allows it (the pure verdict rules: helpdesk-intake-adapters.test.ts)
//   #22 subject patterns: super-linear ones refused at save
//   #35 the inbound body read through a byte cap whatever its framing
//   #36 failed intake keys rate limited before any write; one log row a minute
//   #37 per-person upload quota, with stale drafts reclaimed
//   S3  internal-note notices: no Reply-To, no subject ref, own Message-ID;
//       an agent's reply to one is an internal note
//
// Fixtures are this file's own (a team with a unique alias, accounts,
// integrations, tickets). The pipeline is driven with outsideSenders and
// trustUnverified given. The few global settings the webhook path and the
// trust setting need are written under one advisory lock and restored.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-review-fixes-s2.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PoolClient } from "pg";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-review-s2.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-review-s2.virtual.js");
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
const parse = require("../src/lib/helpdesk/inbound-parse") as typeof import("../src/lib/helpdesk/inbound-parse");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const settingsLib = require("../src/lib/helpdesk/settings") as typeof import("../src/lib/helpdesk/settings");
const sanitize = require("../src/lib/helpdesk/intake/sanitize") as typeof import("../src/lib/helpdesk/intake/sanitize");
const intake = require("../src/lib/helpdesk/intake/intake") as typeof import("../src/lib/helpdesk/intake/intake");
const integrations = require("../src/lib/helpdesk/intake/integrations") as typeof import("../src/lib/helpdesk/intake/integrations");
const http = require("../src/lib/helpdesk/intake/http") as typeof import("../src/lib/helpdesk/intake/http");
const settingsRoute = require("../src/app/api/helpdesk/admin/settings/route") as typeof import("../src/app/api/helpdesk/admin/settings/route");
const uploadRoute = require("../src/app/api/helpdesk/attachments/route") as typeof import("../src/app/api/helpdesk/attachments/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hds2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DOMAIN = `${STAMP}.example.test`;
const ALIAS = `${STAMP}-it@example.test`;
const PASSWORD = "ReviewS2!Test123";
let teamId = 0;
let uploadDirectory = "";
const ticketIds: number[] = [];
const integrationIds: number[] = [];
const mail: HelpdeskOutgoingMail[] = [];
type Person = { id: number; email: string; session: string; name: string };
const U: Record<"req" | "agent" | "mgr" | "admin" | "other", Person> = {} as never;

function inboundEmail(over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: U.req.email, name: "Somebody" },
    to: [{ email: ALIAS, name: "" }],
    cc: [],
    recipients: [],
    subject: `${STAMP} Printer jam`,
    text: "The printer on 3 jams.",
    html: "",
    stripped: "",
    messageId: `${newToken()}@mail.example.test`,
    inReplyTo: "",
    references: [],
    headers: {},
    files: [],
    ...over,
  };
}

const PASS = { dmarc: "pass" };

async function ticketByNumber(n: number) {
  const r = await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n]);
  if (r.rows[0]) ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

async function messagesOf(ticketId: number) {
  return (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows;
}

const settle = () => new Promise((r) => setTimeout(r, 300));

function sessionRequest(url: string, session: string | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.78", "user-agent": "ReviewS2Test/1.0" };
  if (session) headers.cookie = `compass_session=${session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function respond(res: Response) {
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body: body as any };
}

async function callNoParams(handler: (req: Request) => Promise<Response>, req: Request) {
  currentRequest = req;
  try {
    return await respond(await handler(req));
  } finally {
    currentRequest = null;
  }
}

const textOfNode = (n: any): string => (typeof n.value === "string" ? n.value : (n.children ?? []).map(textOfNode).join(""));

/**
 * The markdown as the desk's renderer parses it (GFM and directives; GFM's
 * literal autolinks are found in the parsed text, after escapes, so text
 * that spells a URL still becomes a link to it), flattened to node types
 * and links.
 */
function rendered(md: string): { types: Set<string>; links: { url: string; text: string }[] } {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(md) as any;
  const types = new Set<string>();
  const links: { url: string; text: string }[] = [];
  const walk = (n: any) => {
    types.add(n.type);
    if (n.type === "link" || n.type === "image" || n.type === "definition") links.push({ url: n.url, text: textOfNode(n) });
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return { types, links };
}

/**
 * No image, directive, raw HTML or definition; every link is one of
 * `allowedLinks` or shows its own address (GFM's literal autolinks: the
 * text is the URL, so nothing is disguised).
 */
function assertInert(md: string, allowedLinks: string[] = []) {
  const r = rendered(md);
  for (const t of ["image", "imageReference", "definition", "leafDirective", "textDirective", "containerDirective", "html"]) {
    assert.ok(!r.types.has(t), `no ${t} in ${JSON.stringify(md)}`);
  }
  for (const l of r.links) {
    if (allowedLinks.includes(l.url)) continue;
    let host = "";
    try {
      host = new URL(l.url).host;
    } catch {
      /* not a URL */
    }
    assert.ok(/^(https?|mailto):/i.test(l.url) && host !== "" && l.text.toLowerCase().includes(host.toLowerCase().replace(/%7d$/i, "")), `a link that hides its target: ${JSON.stringify(l)} in ${JSON.stringify(md)}`);
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  await integrations.ensureIntakeSchema();
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hds2-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;
  const creds = hashPassword(PASSWORD);
  const names = { req: "Matthew Felix", agent: "Priya Shah", mgr: "Dana Whitfield", admin: "Ada Admin", other: "Ben Lo" };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const [k, name] of Object.entries(names) as [keyof typeof U, string][]) {
    const addr = `${k}@${DOMAIN}`;
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, name, addr, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[k] = { id: r.rows[0].id, email: addr, session, name };
  }
  const assign = (user: number, role: string) =>
    fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`, [user, role]);
  for (const k of ["agent", "mgr", "admin"] as const) await assign(U[k].id, "helpdesk-agent");
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'manager'), ($2, 'admin')", [U.mgr.id, U.admin.id]);
  const t = await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 999) RETURNING id", [`${STAMP} IT`, ALIAS]);
  teamId = t.rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent')", [teamId, U.agent.id]);
  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  const userIds = Object.values(U).map((u) => u.id);
  await settle();
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1 OR requester_id = ANY($2) OR id = ANY($3) OR requester_email LIKE $4", [teamId, userIds, ticketIds, `%${DOMAIN}`])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_attachments WHERE ticket_id = ANY($1) OR uploaded_by = ANY($2)", [all, userIds]).catch(() => {});
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_integrations WHERE id = ANY($1)", [integrationIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE target_label LIKE $1 OR actor_id = ANY($2) OR target_label LIKE $3", [`${STAMP}%`, userIds, `%${DOMAIN}`]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

// --- #7 inbound bodies ----------------------------------------------------------------

describe("#7 inbound bodies are text, links written by us", () => {
  test("the review's payloads come out inert", () => {
    for (const s of [
      "![x](https://evil.example/p.png)@a.io",
      "[Your session expired, sign in](https://evil.example)@a.io",
      '::embed{src="https://evil.example/@a.io"}',
      '::video{src="https://evil.example/v.mp4"}',
      ":abbr[x]{title=y} and :::note",
      "<img src=https://evil.example/p.png>@a.io",
      "[r]: https://evil.example/p.png",
      "![t][r]",
    ]) {
      const md = parse.textToSafeMarkdown(s);
      assertInert(md);
      assert.equal(parse.markdownToPlain(md), s, "the notification email quotes the text as written");
    }
  });

  test("plain URLs and addresses still link, as autolinks; trailing punctuation stays text", () => {
    const md = parse.textToSafeMarkdown("See https://status.example.test/a_b?x=1. Or (https://en.wikipedia.org/wiki/Foo_(bar)) or mail it_desk@corp.example.test");
    assertInert(md, ["https://status.example.test/a_b?x=1", "https://en.wikipedia.org/wiki/Foo_(bar)", "mailto:it_desk@corp.example.test"]);
    assert.ok(md.includes("<https://status.example.test/a_b?x=1>."), md);
  });

  test("an HTML email walks the same way", () => {
    const body = parse.inboundBody(
      inboundEmail({ text: "", html: '<p><a href="https://evil.example/login">![x](https://evil.example/p.png)@a.io</a></p><p>::embed{src="https://evil.example/@a.io"}</p>' }),
      { reply: false }
    );
    assertInert(body, ["https://evil.example/login"]);
  });
});

// --- #8 alert descriptions ------------------------------------------------------------------

describe("#8 alert descriptions keep only text and http(s) links we write", () => {
  test("directives, reference and nested images, raw HTML: none survive", () => {
    const cases: [string, string[]][] = [
      ['::embed{src="https://evil.example/login" height="800"}', []],
      ['::video{src="https://evil.example/v.mp4"}', []],
      ["![t][r]\n\n[r]: https://evil.example/p.png", ["https://evil.example/p.png"]],
      ["![a [b] c](https://evil.example/q.png)", ["https://evil.example/q.png"]],
      ["Disk **full** on `db-1`\n\n- [runbook](https://ok.example.test/rb)\n- [bad](javascript:alert(1))\n\n<iframe src=https://evil.example></iframe>", ["https://ok.example.test/rb"]],
      [":::callout{kind=warn}\nhello ::embed[x]{src=https://evil.example}\n:::", []],
      ["```mermaid\ngraph TD\n```", []],
    ];
    for (const [src, links] of cases) {
      const md = sanitize.sanitizeDescription(src);
      assertInert(md, links);
      assert.ok(!/```mermaid/.test(md), "no fence language survives");
    }
    // Images became links (nothing loads), formatting stays.
    assert.match(sanitize.sanitizeDescription("![graph](https://g.example.test/p.png)"), /^\[graph\]\(<https:\/\/g\.example\.test\/p\.png>\)$/);
    assert.match(sanitize.sanitizeDescription("Disk **full**"), /\*\*full\*\*/);
  });

  test("a link URL cannot break out of the opening message's link", () => {
    const integration = { severity_map: {}, default_priority: "normal" as const };
    const p = intake.prepareAlert(integration as never, {
      title: "t",
      description: "d",
      severity: "",
      status: "firing",
      dedup_key: "k",
      source: "",
      links: [{ label: "Run]book", url: "https://ok.example/a)![x](https://evil.example/p.png" }],
      fields: {},
    } as never);
    const body = intake.openingBody(p, null);
    const r = rendered(body);
    assert.ok(!r.types.has("image"), body);
    assert.equal(r.links.length, 1, body);
    assert.ok(r.links[0].url.startsWith("https://ok.example/a%29%21%5Bx%5D"), r.links[0].url);
  });
});

// --- #9 human mail and sender authentication --------------------------------------------------

describe("#9 the From address counts only for an authenticated sender", () => {
  let number = 0;
  let token = "";

  test("an authenticated employee opens a ticket as themselves", async () => {
    const r = await inbound.processInboundEmail(inboundEmail({ auth: PASS }), { outsideSenders: false, trustUnverified: false });
    assert.equal(r.body.outcome, "created");
    const t = await ticketByNumber(r.body.ticket!);
    assert.equal(t.requester_id, U.req.id);
    number = t.number;
    token = (await email.ensureReplyToken(t.id))!;
  });

  test("a forged employee From with no verdict: refused with Outside senders off, audited as unverified", async () => {
    const r = await inbound.processInboundEmail(inboundEmail({ from: { email: U.mgr.email, name: "CFO" }, subject: `${STAMP} payroll export` }), { outsideSenders: false, trustUnverified: false, ip: "198.51.100.10" });
    assert.equal(r.body.outcome, "rejected_outside_sender");
    const a = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.inbound.rejected' AND target_label = $1 ORDER BY id DESC LIMIT 1", [U.mgr.email]);
    assert.equal(a.rows[0].details.reason, "unverified_sender");
    assert.equal(a.rows[0].details.sender_check, "none");
  });

  test("a failing verdict is never trusted, even with the trust setting on", async () => {
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.mgr.email, name: "" }, auth: { spf: "fail", dkim: "none" } }),
      { outsideSenders: false, trustUnverified: true }
    );
    assert.equal(r.body.outcome, "rejected_outside_sender");
  });

  test("Outside senders on: the forged mail opens an outsider's ticket with an internal warning, no account", async () => {
    const r = await inbound.processInboundEmail(inboundEmail({ from: { email: U.mgr.email, name: "CFO" }, subject: `${STAMP} urgent` }), { outsideSenders: true, trustUnverified: false });
    assert.equal(r.body.outcome, "created");
    const t = await ticketByNumber(r.body.ticket!);
    assert.equal(t.requester_id, null, "not linked to the account it names");
    const notes = (await messagesOf(t.id)).filter((m) => m.kind === "internal");
    assert.ok(notes.some((m) => /treated as mail from outside the workspace/.test(m.body)), JSON.stringify(notes));
  });

  test("a reply with the ticket's token but no verdict never lands on the ticket", async () => {
    const t = await ticketByNumber(number);
    const before = (await messagesOf(t.id)).length;
    for (const from of [U.req.email, U.agent.email]) {
      const r = await inbound.processInboundEmail(
        inboundEmail({ from: { email: from, name: "" }, subject: `Re: [#${number} ref:${token}]`, text: "Send it to me@evil.example" }),
        { outsideSenders: false, trustUnverified: false }
      );
      assert.equal(r.body.outcome, "rejected_outside_sender", from);
    }
    // Outside senders on: a new outsider ticket, still never the existing one.
    const on = await inbound.processInboundEmail(inboundEmail({ subject: `Re: [#${number} ref:${token}]`, text: "x" }), { outsideSenders: true, trustUnverified: false });
    assert.equal(on.body.outcome, "created");
    assert.notEqual(on.body.ticket, number);
    await ticketByNumber(on.body.ticket!);
    assert.equal((await messagesOf(t.id)).length, before);
  });

  test("an authenticated reply with the token from a non-participant is still a ticket of their own", async () => {
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.other.email, name: "" }, subject: `Re: [#${number} ref:${token}]`, auth: PASS }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r.body.outcome, "created");
    assert.notEqual(r.body.ticket, number);
    await ticketByNumber(r.body.ticket!);
  });

  test("the authenticated requester's reply threads; with the trust setting on, so does one with no verdict", async () => {
    const a = await inbound.processInboundEmail(inboundEmail({ subject: `Re: [#${number} ref:${token}]`, text: "Still jammed.", auth: PASS }), { outsideSenders: false, trustUnverified: false });
    assert.equal(a.body.outcome, "appended");
    const b = await inbound.processInboundEmail(inboundEmail({ subject: `Re: [#${number} ref:${token}]`, text: "And again." }), { outsideSenders: false, trustUnverified: true });
    assert.equal(b.body.outcome, "appended");
  });

  test("a verdict for another domain (attacker-signed) does not authenticate", async () => {
    const r = await inbound.processInboundEmail(
      inboundEmail({ provider: "sendgrid", auth: { spf: "pass", envelopeFrom: "x@evil.example", dkim: "{@evil.example : pass}" } }),
      { outsideSenders: false, trustUnverified: true }
    );
    assert.equal(r.body.outcome, "rejected_outside_sender");
  });
});

// --- #10 machine mail fails closed -------------------------------------------------------------

describe("#10 automated mail without a verdict is refused unless the integration allows it", () => {
  const FROM = `${STAMP}-monitor@monitor.example.test`;
  let id = 0;
  const alert = (over: Partial<InboundEmail> = {}) =>
    inboundEmail({ from: { email: FROM, name: "" }, subject: `[FIRING:1] ${STAMP} disk full`, headers: { "auto-submitted": "auto-generated" }, ...over });

  before(async () => {
    const { integration } = await integrations.createIntegration({ kind: "email", name: `${STAMP} Mon`, sender_addresses: [FROM], default_team_id: teamId }, null);
    id = integration.id;
    integrationIds.push(id);
    assert.equal(integration.allow_unverified_mail, false, "off by default");
  });

  test("no verdict: refused; a forged pass below the provider's Received: refused", async () => {
    const r = await inbound.processInboundEmail(alert(), { outsideSenders: false });
    assert.equal(r.body.outcome, "alert_rejected");
    const forged = await inbound.processInboundEmail(
      alert({ headerList: [["received", "from evil by mx"], ["authentication-results", "x; dmarc=pass header.from=monitor.example.test"]] }),
      { outsideSenders: false }
    );
    assert.equal(forged.body.outcome, "alert_rejected");
    const del = await integrations.listDeliveries(id);
    assert.equal(del.length, 1, "one log row a minute per reason, not one per mail");
    assert.match(del[0].reason, /No SPF, DKIM or DMARC verdict/);
  });

  test("allowed: no verdict is accepted, a failing one still is not", async () => {
    await integrations.updateIntegration(id, { allow_unverified_mail: true });
    const ok = await inbound.processInboundEmail(alert(), { outsideSenders: false });
    assert.equal(ok.body.outcome, "alert_created");
    await ticketByNumber(ok.body.ticket!);
    const bad = await inbound.processInboundEmail(alert({ auth: { spf: "fail" }, subject: `[FIRING:1] ${STAMP} other` }), { outsideSenders: false });
    assert.equal(bad.body.outcome, "alert_rejected");
  });

  test("#22 a super-linear subject pattern is refused at save", () => {
    assert.throws(() => integrations.validateIntegrationInput({ subject_dedup_pattern: "^(\\w+\\s?)+:" }, { create: false }), /not a valid regular expression|safe/);
    assert.doesNotThrow(() => integrations.validateIntegrationInput({ subject_dedup_pattern: "Job (\\w+) failed" }, { create: false }));
  });
});

// --- #35 the inbound body cap ----------------------------------------------------------------------

describe("#35 the inbound body is read through a byte cap", () => {
  const chunked = (bytes: number) => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= bytes) return c.close();
        sent += chunk.length;
        c.enqueue(chunk);
      },
    });
    // No Content-Length: the framing a chunked POST has.
    return new Request("http://localhost/api/helpdesk/inbound/x", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  };

  test("a chunked body over the cap is refused while it is read; one under it parses", async () => {
    const req = chunked(64 * 1024);
    assert.equal(req.headers.get("content-length"), null);
    await assert.rejects(parse.parseInboundRequest(req, "", 16 * 1024), parse.InboundTooLargeError);
    const ok = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "a@b.example", subject: "s", text: "t" }) });
    assert.equal((await parse.parseInboundRequest(ok, "", 16 * 1024)).subject, "s");
  });
});

// --- #36 failed intake keys --------------------------------------------------------------------------

describe("#36 failed intake keys are limited before any write", () => {
  test("one address: 30 failures, then 429 without a lookup; one deliveries row; a right key elsewhere still works", async () => {
    http.resetIntakeAuthFailuresForTests();
    const { integration, key } = await integrations.createIntegration({ kind: "webhook_generic", name: `${STAMP} Webhook`, default_team_id: teamId }, null);
    integrationIds.push(integration.id);
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    const bad = () =>
      http.handleIntakeRequest(new Request(`http://localhost/api/helpdesk/intake/${integration.id}`, { method: "POST", headers: { authorization: "Bearer cdhk_wrong" }, body: "{}" }), String(integration.id), { ip });
    const statuses: number[] = [];
    for (let i = 0; i < http.INTAKE_AUTH_FAIL_LIMITS.perIp + 5; i++) statuses.push((await bad()).status);
    assert.deepEqual(statuses.slice(0, http.INTAKE_AUTH_FAIL_LIMITS.perIp), Array(http.INTAKE_AUTH_FAIL_LIMITS.perIp).fill(401));
    assert.deepEqual(statuses.slice(http.INTAKE_AUTH_FAIL_LIMITS.perIp), Array(5).fill(429));
    const rows = await integrations.listDeliveries(integration.id);
    assert.equal(rows.length, 1, "at most one rejected row per reason a minute");
    // The tool itself, from its own address, is not locked out: a bad body is a 400, not 401/429.
    const good = await http.handleIntakeRequest(
      new Request(`http://localhost/api/helpdesk/intake/${integration.id}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "not json" }),
      String(integration.id),
      { ip: "192.0.2.200" }
    );
    assert.equal(good.status, 400);
    http.resetIntakeAuthFailuresForTests();
  });
});

// --- #37 upload quota --------------------------------------------------------------------------------

describe("#37 unbound uploads have a per-person quota", () => {
  const upload = (session: string) => {
    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
    return callNoParams(uploadRoute.POST, new Request("http://localhost/api/helpdesk/attachments", { method: "POST", headers: { cookie: `compass_session=${session}`, "x-forwarded-for": "203.0.113.79" }, body: form }));
  };
  const seed = (userId: number, n: number, ageHours: number) =>
    pool().query(
      `INSERT INTO hd_attachments (stored_name, filename, mime_type, size, uploaded_by, created_at)
       SELECT $1 || '-' || g || '.txt', 'x.txt', 'text/plain', 1024, $2, now() - make_interval(hours => $4)
         FROM generate_series(1, $3) g`,
      [`${STAMP}-${userId}-${ageHours}`, userId, n, ageHours]
    );

  test("over the unbound count: 429; once the drafts are stale they are reclaimed and the upload goes through", async () => {
    const me = U.other;
    const first = await upload(me.session);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await seed(me.id, 60, 0);
    const over = await upload(me.session);
    assert.equal(over.status, 429, JSON.stringify(over.body));
    assert.match(over.body.error, /too many files waiting/i);
    await pool().query("UPDATE hd_attachments SET created_at = now() - interval '7 hours' WHERE uploaded_by = $1", [me.id]);
    const again = await upload(me.session);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const left = await pool().query("SELECT count(*)::int AS n FROM hd_attachments WHERE uploaded_by = $1 AND message_id IS NULL", [me.id]);
    assert.equal(left.rows[0].n, 1, "the stale drafts were removed, the new upload kept");
  });

  test("over the unbound bytes: 429", async () => {
    const me = U.agent;
    await pool().query(
      `INSERT INTO hd_attachments (stored_name, filename, mime_type, size, uploaded_by) VALUES ($1, 'big.zip', 'application/zip', $2, $3)`,
      [`${STAMP}-big-${me.id}.zip`, 300 * 1024 * 1024, me.id]
    );
    const r = await upload(me.session);
    assert.equal(r.status, 429);
  });
});

// --- Global settings: the webhook path, the trust setting, note notices ---------------------------------

describe("with the inbound address configured (global settings, under a lock)", () => {
  const LOCK = 728351;
  let lockClient: PoolClient | null = null;
  let saved: { secret: string; address: string; auth: string | undefined } = { secret: "", address: "", auth: undefined };

  before(async () => {
    lockClient = await pool().connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
    const s = await settingsLib.getHelpdeskSettings();
    saved = { secret: s.inbound_secret, address: s.inbound_address, auth: await getSetting(inbound.HD_INBOUND_AUTH_KEY) };
    await settingsLib.saveHelpdeskSettings({
      inbound_secret: s.inbound_secret || settingsLib.newInboundSecret(),
      inbound_address: s.inbound_address || "help@example.test",
    });
  });

  after(async () => {
    await settingsLib.saveHelpdeskSettings({ inbound_secret: saved.secret, inbound_address: saved.address });
    if (saved.auth === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [inbound.HD_INBOUND_AUTH_KEY]);
    else await pool().query("UPDATE settings SET value = $2 WHERE key = $1", [inbound.HD_INBOUND_AUTH_KEY, saved.auth]);
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
      lockClient.release();
    }
  });

  test("#5 a Manager (sla.manage, csat.manage) reads the settings without the webhook path; channels.manage gets it", async () => {
    const mgr = await callNoParams(settingsRoute.GET, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.mgr.session, undefined, "GET"));
    assert.equal(mgr.status, 200, JSON.stringify(mgr.body));
    assert.equal(mgr.body.inbound_path, null);
    assert.equal(mgr.body.settings.inbound_enabled, true);
    assert.ok(!JSON.stringify(mgr.body).includes((await settingsLib.getHelpdeskSettings()).inbound_secret), "the secret is nowhere in the answer");
    // The PATCH answer is masked the same way.
    const patched = await callNoParams(settingsRoute.PATCH, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.mgr.session, { csat_enabled: true }, "PATCH"));
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.inbound_path, null);
    const admin = await callNoParams(settingsRoute.GET, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.admin.session, undefined, "GET"));
    assert.match(admin.body.inbound_path, /^\/api\/helpdesk\/inbound\/[A-Za-z0-9_-]+$/);
  });

  test("#9 the trust setting: off by default, channels.manage only, audited", async () => {
    await pool().query("DELETE FROM settings WHERE key = $1", [inbound.HD_INBOUND_AUTH_KEY]);
    const before = await callNoParams(settingsRoute.GET, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.admin.session, undefined, "GET"));
    assert.equal(before.body.settings.trust_unverified_senders, false);
    const denied = await callNoParams(settingsRoute.PATCH, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.mgr.session, { trust_unverified_senders: true }, "PATCH"));
    assert.equal(denied.status, 403);
    const on = await callNoParams(settingsRoute.PATCH, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.admin.session, { trust_unverified_senders: true }, "PATCH"));
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.settings.trust_unverified_senders, true);
    assert.equal((await inbound.getInboundAuthSettings()).trust_unverified_senders, true);
    const a = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.settings.updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [U.admin.id]);
    assert.ok(a.rows[0].details.changed.includes("trust_unverified_senders"));
    const bad = await callNoParams(settingsRoute.PATCH, sessionRequest("http://localhost/api/helpdesk/admin/settings", U.admin.session, { trust_unverified_senders: "yes" }, "PATCH"));
    assert.equal(bad.status, 400);
    await inbound.saveInboundAuthSettings({ trust_unverified_senders: false });
  });

  test("#35 the webhook refuses a chunked body over the cap with 413", async () => {
    const secret = (await settingsLib.getHelpdeskSettings()).inbound_secret;
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        // Just over the cap, in 1 MB chunks, with no Content-Length.
        const mb = new Uint8Array(1024 * 1024).fill(32);
        for (let i = 0; i <= parse.INBOUND_MAX_BODY_BYTES / mb.length; i++) c.enqueue(mb);
        c.close();
      },
    });
    const req = new Request(`http://localhost/api/helpdesk/inbound/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: big, duplex: "half" } as RequestInit);
    const r = await inbound.handleInbound(req, secret);
    assert.equal(r.status, 413);
  });

  test("S3 internal-note notice: no Reply-To, no subject ref, its own Message-ID; an agent's reply to it stays internal", async () => {
    const created = await inbound.processInboundEmail(inboundEmail({ auth: PASS, subject: `${STAMP} note thread` }), { outsideSenders: false, trustUnverified: false });
    const t = await ticketByNumber(created.body.ticket!);
    await settle();
    mail.length = 0;
    const sent = await email.sendHelpdeskEmail(U.agent.id, email.HD_NOTE_NOTICE_TEMPLATE, { ticket_number: String(t.number), author_name: "Dana", message: "Legal is reviewing." });
    assert.equal(sent, true);
    const m = mail.find((x) => x.to === U.agent.email)!;
    assert.ok(m, "the notice went out");
    assert.equal(m.replyTo, undefined);
    assert.ok(!m.subject.includes("ref:"), m.subject);
    assert.ok(email.isNoteNoticeMessageId(m.messageId!), m.messageId);
    // Control: an ordinary ticket mail still threads with a Reply-To.
    await email.sendHelpdeskEmail(U.agent.id, "hd_assigned", { ticket_number: String(t.number) });
    const normal = mail.find((x) => x.to === U.agent.email && x !== m)!;
    assert.ok(normal.replyTo?.includes("+hd-"), JSON.stringify(normal));

    mail.length = 0;
    const noteId = m.messageId!.replace(/^<|>$/g, "");
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.agent.email, name: "" }, auth: PASS, subject: "Re: note", inReplyTo: noteId, references: [m.references!.replace(/^<|>$/g, ""), noteId], text: "Noted, will hold." }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r.body.outcome, "appended");
    assert.equal(r.body.ticket, t.number);
    const last = (await messagesOf(t.id)).at(-1);
    assert.equal(last.kind, "internal");
    assert.equal(last.author_id, U.agent.id);
    await settle();
    assert.equal(mail.filter((x) => x.to === U.req.email).length, 0, "the requester hears nothing");
  });
});

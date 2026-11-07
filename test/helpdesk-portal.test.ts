// Helpdesk 1.19.1: the customer portal for people outside the workspace
// (agent V6, lib/helpdesk/portal). Security first:
//   - sign-in links: one-time, 15 minutes, only their SHA-256 stored
//   - asking for a link answers the same whatever the address (allowed,
//     unknown, blocked, outside the approved domains)
//   - a portal session never reaches an app route, an app session never a
//     portal route; the cookie is its own name, scoped to /support
//   - a contact reaches only their own tickets (number AND contact id),
//     their own files; never internal notes, held replies or system lines;
//     agents by first name
//   - only exposed request types that need nothing from the directory
//   - the access rule (anyone / approved domains), blocked domains, blocked
//     contacts, blocked words
//   - rate limits (per address, per network address, per hour of requests)
//   - same-origin on every portal write
//   - notices by email only, with a portal link; inbound replies thread for
//     the contact's own ticket only, and never for a blocked contact
//
// The portal's settings are one workspace key (helpdesk_portal): this file
// writes it under an advisory lock (728661, shared with
// e2e/helpdesk-portal.spec.ts) and restores it. Every other fixture is its
// own (a stamped team, request types, accounts, contacts).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-portal.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-portal.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-portal.virtual.js");
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

/* eslint-disable @typescript-eslint/no-require-imports */
const portal = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const auth = require("../src/lib/auth") as typeof import("../src/lib/auth");
const linkRoute = require("../src/app/(portal)/support/api/link/route") as typeof import("../src/app/(portal)/support/api/link/route");
const sessionRoute = require("../src/app/(portal)/support/api/session/route") as typeof import("../src/app/(portal)/support/api/session/route");
const requestsRoute = require("../src/app/(portal)/support/api/requests/route") as typeof import("../src/app/(portal)/support/api/requests/route");
const requestRoute = require("../src/app/(portal)/support/api/requests/[number]/route") as typeof import("../src/app/(portal)/support/api/requests/[number]/route");
const replyRoute = require("../src/app/(portal)/support/api/requests/[number]/messages/route") as typeof import("../src/app/(portal)/support/api/requests/[number]/messages/route");
const filesRoute = require("../src/app/(portal)/support/api/files/[id]/route") as typeof import("../src/app/(portal)/support/api/files/[id]/route");
const appRequestsRoute = require("../src/app/api/helpdesk/requests/route") as typeof import("../src/app/api/helpdesk/requests/route");
const adminRoute = require("../src/app/api/helpdesk/admin/portal/route") as typeof import("../src/app/api/helpdesk/admin/portal/route");
const adminContactRoute = require("../src/app/api/helpdesk/admin/portal/contacts/[id]/route") as typeof import("../src/app/api/helpdesk/admin/portal/contacts/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";
import type { PortalSettings } from "../src/lib/helpdesk/portal-shared";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";

// --- Fixtures ---------------------------------------------------------------------

const STAMP = `hdportal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CUST = `${STAMP}.clientco.test`;
const OTHER = `${STAMP}.elsewhere.test`;
const HOST = "portal.example.test";
const ORIGIN = `http://${HOST}`;
const LOCK = 728661;
let lockClient: PoolClient;
let savedSettings: string | undefined;
let uploadDirectory = "";
let teamId = 0;
let team2Id = 0;
const typeIds: Record<"billing" | "bug" | "person" | "manager" | "hidden", number> = {} as never;
let workflowId = 0;
const mail: HelpdeskOutgoingMail[] = [];
const links = new Map<string, string>();
const userIds: number[] = [];
let agent = { id: 0, session: "" };
let admin = { id: 0, session: "" };
let requester = { id: 0, session: "", email: "" };

function settings(over: Partial<PortalSettings> = {}): PortalSettings {
  return portal.cleanPortalSettings({
    enabled: true,
    types: [
      { id: typeIds.billing, team_id: team2Id },
      { id: typeIds.bug, team_id: null },
    ],
    access: "anyone",
    domains: [],
    brand_name: "Acme Support",
    limits: { links_per_email_hour: 5, requests_per_email_hour: 5 },
    blocked_words: ["casino"],
    blocked_domains: [`spam.${STAMP}.test`],
    ...over,
  });
}

async function useSettings(s: PortalSettings) {
  await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(s));
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function respond(res: Response) {
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body: body as any, headers: res.headers };
}

type Opts = { method?: string; cookie?: string; origin?: string | null; json?: unknown; form?: FormData; secFetch?: string };

let ipSeq = 0;
async function makeRequest(url: string, o: Opts = {}): Promise<Request> {
  // A network address per request: the per-address limits have their own test.
  ipSeq = (ipSeq % 250) + 1;
  const headers: Record<string, string> = { host: HOST, "x-forwarded-for": `203.0.113.${ipSeq}`, "user-agent": "PortalTest/1.0" };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.secFetch) headers["sec-fetch-site"] = o.secFetch;
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form) {
    const r = new Response(o.form);
    const buf = Buffer.from(await r.arrayBuffer());
    headers["content-type"] = r.headers.get("content-type")!;
    headers["content-length"] = String(buf.length);
    body = buf;
  }
  return new Request(`${ORIGIN}${url}`, { method: o.method ?? (body ? "POST" : "GET"), headers, body });
}

async function call<P extends Record<string, string> | undefined>(
  handler: (req: Request, ctx: any) => Promise<Response>,
  url: string,
  o: Opts = {},
  params?: P
) {
  const req = await makeRequest(url, o);
  currentRequest = req;
  try {
    return await respond(await handler(req, params ? { params: Promise.resolve(params) } : undefined));
  } finally {
    currentRequest = null;
  }
}

const portalCookie = (token: string) => `compass_portal=${token}`;

/** Ask for a link through the route and read it from the mailer (the spy sees it as it is mailed). */
async function signIn(addr: string): Promise<string> {
  links.delete(addr);
  const r = await call(linkRoute.POST, "/support/api/link", { json: { email: addr } });
  assert.equal(r.status, 200);
  for (let i = 0; i < 40 && !links.has(addr); i++) await settle(50);
  const url = links.get(addr);
  assert.ok(url, `a link was mailed to ${addr}`);
  const token = new URL(url!).searchParams.get("token")!;
  const s = await call(sessionRoute.POST, "/support/api/session", { json: { token } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const set = s.headers.get("set-cookie") ?? "";
  const m = /compass_portal=([^;]+)/.exec(set);
  assert.ok(m, "the portal cookie is set");
  return portalCookie(m![1]);
}

function form(fields: Record<string, string>, files: { name: string; data: Buffer; type?: string }[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const file of files) f.append("files", new Blob([new Uint8Array(file.data)], { type: file.type ?? "application/octet-stream" }), file.name);
  return f;
}

async function raise(cookie: string, typeId: number, subject: string, body = "It broke.", files: { name: string; data: Buffer }[] = []) {
  return call(requestsRoute.POST, "/support/api/requests", { cookie, form: form({ request_type_id: String(typeId), subject, body, answers: "{}" }, files) });
}

async function ticketOf(number: number) {
  return (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [number])).rows[0];
}

async function newUser(tag: string, name: string): Promise<{ id: number; session: string; email: string }> {
  const addr = `${tag}@${STAMP}.corp.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${tag}`, name, addr]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  return { id, session, email: addr };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
  savedSettings = await getSetting(portal.HD_PORTAL_SETTINGS_KEY);
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hdportal-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;

  const a = await newUser("agent", "Priya Shah");
  agent = { id: a.id, session: a.session };
  const ad = await newUser("admin", "Ada Admin");
  admin = { id: ad.id, session: ad.session };
  requester = await newUser("req", "Matthew Felix");
  const assign = (user: number, role: string) =>
    fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = $2`, [user, role]);
  await assign(agent.id, "helpdesk-agent");
  await assign(admin.id, "helpdesk-agent");
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'", [admin.id]);

  teamId = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 999) RETURNING id", [`${STAMP} Support team`])).rows[0].id;
  team2Id = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 999) RETURNING id", [`${STAMP} Accounts`])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($3, $2, 'agent')", [teamId, agent.id, team2Id]);

  const rt = async (slug: string, title: string, formDef: unknown[] = [], extra: { workflow_id?: number } = {}) =>
    (
      await fixtureQuery(
        "INSERT INTO hd_request_types (slug, title, team_id, form, workflow_id, position) VALUES ($1, $2, $3, $4, $5, 999) RETURNING id",
        [`${STAMP}-${slug}`, title, teamId, JSON.stringify(formDef), extra.workflow_id ?? null]
      )
    ).rows[0].id as number;
  typeIds.billing = await rt("billing", "Billing question", [{ key: "invoice", label: "Invoice number", type: "text", required: true }]);
  typeIds.bug = await rt("bug", "Report a bug");
  typeIds.person = await rt("person", "New laptop", [{ key: "for_whom", label: "Who is it for", type: "user" }]);
  workflowId = (
    await fixtureQuery("INSERT INTO hd_workflows (slug, title, definition, published) VALUES ($1, $2, $3, 1) RETURNING id", [
      `${STAMP}-wf`,
      "Manager approves",
      JSON.stringify({ trigger: {}, steps: [{ key: "a1", kind: "approval", title: "Manager", approver: { kind: "manager" }, on_decline: "close" }] }),
    ])
  ).rows[0].id;
  typeIds.manager = await rt("manager", "Access request", [], { workflow_id: workflowId });
  typeIds.hidden = await rt("hidden", "Not exposed");

  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
  portal.setPortalLinkSpyForTests((addr, url) => links.set(addr, url));
  inbound.resetInboundRateLimitsForTests();
  await useSettings(settings());
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  portal.setPortalLinkSpyForTests(null);
  await settle(400);
  const tickets = (
    await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_email LIKE $2 OR requester_email LIKE $3 OR requester_id = ANY($4)", [
      [teamId, team2Id],
      `%${CUST}`,
      `%${OTHER}`,
      userIds,
    ])
  ).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_attachments WHERE ticket_id = ANY($1)", [tickets]).catch(() => {});
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [tickets]);
  await pool().query("DELETE FROM hd_portal_contacts WHERE email LIKE $1 OR email LIKE $2 OR email LIKE $3", [`%${CUST}`, `%${OTHER}`, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_request_types WHERE slug LIKE $1", [`${STAMP}-%`]);
  await pool().query("DELETE FROM hd_workflows WHERE id = $1", [workflowId]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamId, team2Id]]);
  await pool().query("DELETE FROM audit_log WHERE target_label LIKE $1 OR target_label LIKE $2 OR actor_id = ANY($3)", [`%${CUST}`, `%${OTHER}`, userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  if (savedSettings === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [portal.HD_PORTAL_SETTINGS_KEY]);
  else await setSetting(portal.HD_PORTAL_SETTINGS_KEY, savedSettings);
  await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]);
  lockClient.release();
  await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

// --- Sign-in links ----------------------------------------------------------------------

describe("sign-in links", () => {
  test("a link is stored only as its hash, works once, and opens a session", async () => {
    const addr = `jordan@${CUST}`;
    const outcome = await portal.deliverSignInLink(addr, { origin: ORIGIN });
    assert.equal(outcome, "sent");
    const url = links.get(addr)!;
    const token = new URL(url).searchParams.get("token")!;
    assert.ok(token.length >= 40, "the token is long and random");
    const sent = mail.find((m) => m.to === addr && m.text.includes(token));
    assert.ok(sent, `the link went by email: ${JSON.stringify(mail.filter((m) => m.to === addr).map((m) => m.text))}`);
    assert.match(sent!.subject, /sign-in link for Acme Support/);
    assert.ok(!/Manage your notifications/i.test(sent!.text), "no manage link: the recipient has no account");
    const rows = (await pool().query("SELECT l.token_hash FROM hd_portal_links l JOIN hd_portal_contacts c ON c.id = l.contact_id WHERE c.email = $1", [addr])).rows;
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.notEqual(r.token_hash, token, "never the token itself");
    assert.ok(rows.some((r) => r.token_hash === portal.hashPortalToken(token)), "its SHA-256");

    // Peeking spends nothing.
    assert.deepEqual(await portal.peekSignInLink(token), { email: addr });
    const first = await portal.consumeSignInLink(token, { ip: "203.0.113.1" });
    assert.ok(first, "the first use signs in");
    assert.equal(first!.contact.email, addr);
    assert.equal(await portal.consumeSignInLink(token), null, "the second use does not");
    assert.equal(await portal.peekSignInLink(token), null);
    const contact = await portal.portalSessionContact(first!.sessionToken);
    assert.equal(contact?.email, addr);
    const stored = (await pool().query("SELECT token_hash FROM hd_portal_sessions WHERE contact_id = $1", [contact!.id])).rows;
    assert.ok(stored.every((r) => r.token_hash !== first!.sessionToken), "sessions are hashed at rest too");
    const audit = (await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.portal.signin' AND target_label = $1", [addr])).rows;
    assert.equal(audit.length, 1, "the sign-in is audited");
  });

  test("a link expires after 15 minutes", async () => {
    const addr = `expiry@${CUST}`;
    await portal.deliverSignInLink(addr, { origin: ORIGIN });
    const token = new URL(links.get(addr)!).searchParams.get("token")!;
    await pool().query("UPDATE hd_portal_links SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [portal.hashPortalToken(token)]);
    assert.equal(await portal.consumeSignInLink(token), null);
    const fresh = (await pool().query("SELECT l.expires_at - l.created_at AS ttl FROM hd_portal_links l JOIN hd_portal_contacts c ON c.id = l.contact_id WHERE c.email = $1", [addr])).rows[0];
    assert.ok(fresh, "the row exists");
    const r = await call(sessionRoute.POST, "/support/api/session", { json: { token } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /expired or was already used/);
  });

  test("the link points at the custom domain when one is set, never at a Host header", async () => {
    const before = await getSetting("custom_domain");
    try {
      await setSetting("custom_domain", "help.acme.example");
      const { getAppSettings } = await import("../src/lib/settings-store");
      const s = await getAppSettings();
      if (s.custom_domain === "help.acme.example") {
        const addr = `domain@${CUST}`;
        await portal.deliverSignInLink(addr, { origin: "http://evil.example" });
        assert.match(links.get(addr)!, /^https:\/\/help\.acme\.example\/support\/signin\?token=/);
      }
    } finally {
      if (before === undefined) await pool().query("DELETE FROM settings WHERE key = 'custom_domain'");
      else await setSetting("custom_domain", before);
    }
  });

  test("the session cookie is its own, scoped to /support, HttpOnly and Lax", async () => {
    const addr = `cookie@${CUST}`;
    links.delete(addr);
    await call(linkRoute.POST, "/support/api/link", { json: { email: addr } });
    for (let i = 0; i < 40 && !links.has(addr); i++) await settle(50);
    const token = new URL(links.get(addr)!).searchParams.get("token")!;
    const s = await call(sessionRoute.POST, "/support/api/session", { json: { token } });
    const set = s.headers.get("set-cookie") ?? "";
    assert.match(set, /^compass_portal=/);
    assert.match(set, /Path=\/support/i);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=lax/i);
    assert.ok(!/compass_session/.test(set), "never the app's cookie");
    // Sign out ends it.
    const cookie = portalCookie(/compass_portal=([^;]+)/.exec(set)![1]);
    assert.equal((await call(requestsRoute.GET, "/support/api/requests", { cookie })).status, 200);
    assert.equal((await call(sessionRoute.DELETE, "/support/api/session", { method: "DELETE", cookie })).status, 200);
    assert.equal((await call(requestsRoute.GET, "/support/api/requests", { cookie })).status, 401);
  });
});

// --- Enumeration --------------------------------------------------------------------------

describe("asking for a link never says who exists", () => {
  test("the same answer for a known contact, a new address, a blocked contact and a blocked domain", async () => {
    const known = `known@${CUST}`;
    const cookie = await signIn(known);
    await raise(cookie, typeIds.bug, `${STAMP} known has requests`);
    const blocked = `blocked@${CUST}`;
    await portal.deliverSignInLink(blocked, { origin: ORIGIN });
    const b = await portal.getContactByEmail(blocked);
    await portal.setContactBlocked(b!.id, true);
    links.delete(blocked);
    const answers = [];
    for (const addr of [known, `nobody-${Date.now()}@${CUST}`, blocked, `x@spam.${STAMP}.test`]) {
      const r = await call(linkRoute.POST, "/support/api/link", { json: { email: addr } });
      answers.push({ status: r.status, body: r.body });
    }
    for (const a of answers) assert.deepEqual(a, answers[0]);
    assert.equal(answers[0].status, 200);
    assert.equal(answers[0].body.message, portal.PORTAL_LINK_SENT);
    await settle(400);
    assert.ok(!links.has(blocked), "no link minted for a blocked contact");
    assert.ok(!links.has(`x@spam.${STAMP}.test`), "nor for a blocked domain");
    assert.equal(await portal.deliverSignInLink(blocked, { origin: ORIGIN }), "blocked");
    assert.equal(await portal.deliverSignInLink(`x@spam.${STAMP}.test`, { origin: ORIGIN }), "not_allowed");
    assert.equal(await portal.getContactByEmail(`x@spam.${STAMP}.test`), undefined, "nothing stored for a refused address");
  });

  test("a malformed address is the only other answer (it says nothing about anyone)", async () => {
    const r = await call(linkRoute.POST, "/support/api/link", { json: { email: "not an address" } });
    assert.equal(r.status, 400);
  });
});

// --- Isolation --------------------------------------------------------------------------

describe("session isolation", () => {
  test("a portal session is not an app session, and an app session is not a portal session", async () => {
    const cookie = await signIn(`iso@${CUST}`);
    // The app's own reader ignores the portal cookie.
    currentRequest = await makeRequest("/api/helpdesk/requests", { cookie });
    try {
      assert.equal(await auth.getCurrentUser(), null);
    } finally {
      currentRequest = null;
    }
    const app = await call(appRequestsRoute.GET, "/api/helpdesk/requests", { cookie });
    assert.equal(app.status, 401, "an app API refuses a portal session");
    const both = await call(requestsRoute.GET, "/support/api/requests", { cookie: `compass_session=${requester.session}` });
    assert.equal(both.status, 401, "the portal refuses an app session");
  });

  test("nothing under /api reads the portal cookie or the portal session", () => {
    const root = path.join(__dirname, "..", "src", "app", "api");
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(n)) out.push(p);
      }
      return out;
    };
    for (const f of walk(root)) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/compass_portal|PORTAL_COOKIE|currentPortalContact|portalSessionContact|portalGate/.test(src), `${path.relative(root, f)} must not read the portal session`);
    }
  });
});

describe("a contact reaches only their own", () => {
  test("lists, details and files of another contact are 404s; internal notes, held replies and system lines never show", async () => {
    const aCookie = await signIn(`alice@${CUST}`);
    const bCookie = await signIn(`bob@${OTHER}`);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b60000000049454e44ae426082", "hex");
    const a = await raise(aCookie, typeIds.bug, `${STAMP} Alice's export`, "Export to CSV times out.", [{ name: "screen.png", data: png }]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await raise(bCookie, typeIds.bug, `${STAMP} Bob's thing`);
    assert.equal(b.status, 201);
    const t = await ticketOf(a.body.number);
    assert.equal(t.source, "portal_external");
    assert.equal(t.requester_id, null);
    assert.equal(t.requester_email, `alice@${CUST}`);
    assert.ok(t.portal_contact_id);

    const list = await call(requestsRoute.GET, "/support/api/requests", { cookie: aCookie });
    assert.deepEqual(list.body.requests.map((r: any) => r.number), [a.body.number]);
    const theirs = await call(requestRoute.GET, `/support/api/requests/${b.body.number}`, { cookie: aCookie }, { number: String(b.body.number) });
    assert.equal(theirs.status, 404);
    const missing = await call(requestRoute.GET, "/support/api/requests/999999999", { cookie: aCookie }, { number: "999999999" });
    assert.equal(missing.status, 404);
    assert.deepEqual(theirs.body, missing.body, "someone else's request looks exactly like none");

    // An agent replies, a note, a newbie's held reply, a system line.
    await messages.addMessage(t.id, { kind: "public", body: "Thanks, can you try again now?", author: { id: agent.id, name: "Priya Shah", email: "" }, via: "desk" });
    await messages.addMessage(t.id, { kind: "internal", body: "SECRET internal note", author: { id: agent.id, name: "Priya Shah", email: "" }, via: "desk" });
    await pool().query(
      "INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, review_state) VALUES ($1, $2, 'Priya Shah', '', 'public', 'HELD newbie reply', 'desk', 'pending')",
      [t.id, agent.id]
    );
    await messages.addSystemMessage(t.id, "Assigned to Priya Shah");
    const d = await call(requestRoute.GET, `/support/api/requests/${a.body.number}`, { cookie: aCookie }, { number: String(a.body.number) });
    assert.equal(d.status, 200);
    const text = JSON.stringify(d.body);
    assert.ok(!text.includes("SECRET"), "no internal note");
    assert.ok(!text.includes("HELD"), "no held reply");
    assert.ok(!text.includes("Assigned to"), "no system line");
    assert.ok(!text.includes("Shah"), "no agent surname");
    const authors = d.body.request.messages.map((m: any) => [m.author, m.team]);
    assert.deepEqual(authors[0], ["You", null]);
    assert.deepEqual(authors[1], ["Priya", `${STAMP} Support team`]);
    assert.ok(!("author_email" in d.body.request.messages[1]) && !("author_id" in d.body.request.messages[1]));

    // Files: Alice's own downloads; Bob gets a 404.
    const fileId = d.body.request.messages[0].attachments[0].id;
    const own = await call(filesRoute.GET, `/support/api/files/${fileId}`, { cookie: aCookie }, { id: String(fileId) });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    const stolen = await call(filesRoute.GET, `/support/api/files/${fileId}`, { cookie: bCookie }, { id: String(fileId) });
    assert.equal(stolen.status, 404);
    // A file on an internal note never downloads.
    const note = await pool().query("SELECT id FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' LIMIT 1", [t.id]);
    const att = await pool().query(
      "INSERT INTO hd_attachments (stored_name, filename, mime_type, size, ticket_id, message_id) VALUES ($1, 'note.txt', 'text/plain', 3, $2, $3) RETURNING id",
      [`${"a".repeat(32)}.txt`, t.id, note.rows[0].id]
    );
    const hidden = await call(filesRoute.GET, `/support/api/files/${att.rows[0].id}`, { cookie: aCookie }, { id: String(att.rows[0].id) });
    assert.equal(hidden.status, 404);
    await pool().query("DELETE FROM hd_attachments WHERE id = $1", [att.rows[0].id]);

    // Replying to someone else's request: 404, nothing written.
    const before = (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = (SELECT id FROM hd_tickets WHERE number = $1)", [b.body.number])).rows[0].n;
    const r = await call(replyRoute.POST, `/support/api/requests/${b.body.number}/messages`, { cookie: aCookie, form: form({ body: "hijack" }) }, { number: String(b.body.number) });
    assert.equal(r.status, 404);
    const afterN = (await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = (SELECT id FROM hd_tickets WHERE number = $1)", [b.body.number])).rows[0].n;
    assert.equal(afterN, before);
  });

  test("a reply on their own request reopens it and reaches the desk as the requester's", async () => {
    const cookie = await signIn(`replier@${CUST}`);
    const a = await raise(cookie, typeIds.bug, `${STAMP} needs a reply`);
    const t = await ticketOf(a.body.number);
    await pool().query("UPDATE hd_tickets SET status = 'pending' WHERE id = $1", [t.id]);
    const r = await call(replyRoute.POST, `/support/api/requests/${a.body.number}/messages`, { cookie, form: form({ body: "Here is the detail you asked for." }) }, { number: String(a.body.number) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "open");
    const m = (await pool().query("SELECT author_id, author_email, kind, via FROM hd_messages WHERE ticket_id = $1 AND kind <> 'system' ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.deepEqual(m, { author_id: null, author_email: `replier@${CUST}`, kind: "public", via: "customer_portal" });
  });
});

// --- Exposure -------------------------------------------------------------------------------

describe("what customers can ask for", () => {
  test("only exposed types; the per-type team; a type needing the directory is blocked", async () => {
    const offered = await portal.offeredTypes();
    assert.deepEqual(offered.map((t) => t.id).sort(), [typeIds.billing, typeIds.bug].sort());
    assert.equal(offered.find((t) => t.id === typeIds.billing)!.team_id, team2Id, "the portal's team for the type");
    assert.equal(offered.find((t) => t.id === typeIds.bug)!.team_id, teamId, "else the type's own");
    const rows = await pool().query("SELECT * FROM hd_request_types WHERE id = ANY($1)", [[typeIds.person, typeIds.manager]]);
    for (const rt of rows.rows) {
      const blockers = await portal.portalBlockers(rt);
      assert.ok(blockers.length > 0, `${rt.title} is blocked`);
    }
    assert.deepEqual(await portal.portalBlockers(rows.rows.find((r) => r.id === typeIds.person)), ["person_field"]);
    assert.deepEqual(await portal.portalBlockers(rows.rows.find((r) => r.id === typeIds.manager)), ["manager_approval"]);

    const cookie = await signIn(`types@${CUST}`);
    const hidden = await raise(cookie, typeIds.hidden, "Not exposed");
    assert.equal(hidden.status, 400);
    const blocked = await raise(cookie, typeIds.manager, "Manager approval");
    assert.equal(blocked.status, 400);
    const missing = await raise(cookie, typeIds.billing, "No invoice number");
    assert.equal(missing.status, 400, "answers are checked like the form");
    const ok = await call(requestsRoute.POST, "/support/api/requests", {
      cookie,
      form: form({ request_type_id: String(typeIds.billing), subject: "Invoice 4471 charged twice", body: "Charged twice for one invoice.", answers: JSON.stringify({ invoice: "4471" }) }),
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const t = await ticketOf(ok.body.number);
    assert.equal(t.team_id, team2Id);
    assert.equal(t.form_answers.invoice, "4471");
  });

  test("a type exposed and later given a manager approval is refused when raised", async () => {
    await useSettings(settings({ types: [{ id: typeIds.bug, team_id: null }, { id: typeIds.manager, team_id: null }] }));
    try {
      assert.ok(!(await portal.offeredTypes()).some((t) => t.id === typeIds.manager));
      const cookie = await signIn(`late@${CUST}`);
      assert.equal((await raise(cookie, typeIds.manager, "x")).status, 400);
    } finally {
      await useSettings(settings());
    }
  });

  test("the admin route refuses to expose a blocked type, audits a change, and needs settings.manage", async () => {
    const s = settings();
    const refused = await call(adminRoute.PUT, "/api/helpdesk/admin/portal", {
      method: "PUT",
      cookie: `compass_session=${admin.session}`,
      json: { ...s, types: [...s.types, { id: typeIds.person, team_id: null }] },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /New laptop/);
    const agentTry = await call(adminRoute.PUT, "/api/helpdesk/admin/portal", { method: "PUT", cookie: `compass_session=${agent.session}`, json: s });
    assert.equal(agentTry.status, 403);
    const ok = await call(adminRoute.PUT, "/api/helpdesk/admin/portal", { method: "PUT", cookie: `compass_session=${admin.session}`, json: { ...s, brand_name: `Acme ${STAMP}` } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const audited = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.portal.updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [admin.id]);
    assert.deepEqual(audited.rows[0].details.changed, ["brand_name"]);
    await useSettings(settings());
  });
});

// --- Access rules ----------------------------------------------------------------------------

describe("who can use it", () => {
  test("approved domains only: other domains get nothing, existing sessions of them stop", async () => {
    const outsider = `out@${OTHER}`;
    const cookie = await signIn(outsider);
    await useSettings(settings({ access: "domains", domains: [CUST] }));
    try {
      assert.equal(await portal.deliverSignInLink(outsider, { origin: ORIGIN }), "not_allowed");
      assert.equal(await portal.deliverSignInLink(`sub@eu.${CUST}`, { origin: ORIGIN }), "sent", "a subdomain of an approved one");
      assert.equal((await call(requestsRoute.GET, "/support/api/requests", { cookie })).status, 401, "the session no longer admits them");
    } finally {
      await useSettings(settings());
    }
  });

  test("blocking a contact signs them out, spends their links and stops their notices", async () => {
    const addr = `toblock@${CUST}`;
    const cookie = await signIn(addr);
    const a = await raise(cookie, typeIds.bug, `${STAMP} before the block`);
    const c = await portal.getContactByEmail(addr);
    const r = await call(adminContactRoute.PATCH, `/api/helpdesk/admin/portal/contacts/${c!.id}`, { method: "PATCH", cookie: `compass_session=${admin.session}`, json: { blocked: true } }, { id: String(c!.id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.contact.blocked, 1);
    assert.equal((await call(requestsRoute.GET, "/support/api/requests", { cookie })).status, 401);
    const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.portal.contact_blocked' AND target_label = $1", [addr]);
    assert.equal(audited.rows.length, 1);
    const t = await ticketOf(a.body.number);
    const n = mail.length;
    await messages.addMessage(t.id, { kind: "public", body: "A reply they won't get.", author: { id: agent.id, name: "Priya Shah", email: "" }, via: "desk" });
    await settle();
    assert.ok(!mail.slice(n).some((m) => m.to === addr), "a blocked contact hears nothing");
    await call(adminContactRoute.PATCH, `/api/helpdesk/admin/portal/contacts/${c!.id}`, { method: "PATCH", cookie: `compass_session=${admin.session}`, json: { blocked: false } }, { id: String(c!.id) });
  });

  test("blocked words refuse a request and a reply", async () => {
    const cookie = await signIn(`words@${CUST}`);
    const r = await raise(cookie, typeIds.bug, "Win at the Casino today");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /rephrase/);
    const ok = await raise(cookie, typeIds.bug, "Occasional crash");
    assert.equal(ok.status, 201, "a word inside another word is fine");
  });
});

// --- Rate limits --------------------------------------------------------------------------

describe("rate limits", () => {
  test("links per address per hour, quietly", async () => {
    await useSettings(settings({ limits: { links_per_email_hour: 2, requests_per_email_hour: 5 } }));
    try {
      const addr = `limit-${Date.now()}@${CUST}`;
      assert.equal(await portal.deliverSignInLink(addr, { origin: ORIGIN }), "sent");
      assert.equal(await portal.deliverSignInLink(addr, { origin: ORIGIN }), "sent");
      assert.equal(await portal.deliverSignInLink(addr, { origin: ORIGIN }), "limited");
    } finally {
      await useSettings(settings());
    }
  });

  test("link requests per network address: 429 after ten a minute", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const req = await makeRequest("/support/api/link", { json: { email: `ip${i}@${CUST}` } });
      const h = new Headers(req.headers);
      h.set("x-forwarded-for", "198.51.100.77");
      currentRequest = new Request(req.url, { method: "POST", headers: h, body: JSON.stringify({ email: `ip${i}@${CUST}` }) });
      try {
        last = (await linkRoute.POST(currentRequest)).status;
      } finally {
        currentRequest = null;
      }
    }
    assert.equal(last, 429);
  });

  test("new requests per contact per hour", async () => {
    await useSettings(settings({ limits: { links_per_email_hour: 5, requests_per_email_hour: 2 } }));
    try {
      const cookie = await signIn(`busy@${CUST}`);
      assert.equal((await raise(cookie, typeIds.bug, "one")).status, 201);
      assert.equal((await raise(cookie, typeIds.bug, "two")).status, 201);
      assert.equal((await raise(cookie, typeIds.bug, "three")).status, 429);
    } finally {
      await useSettings(settings());
    }
  });
});

// --- CSRF --------------------------------------------------------------------------------------

describe("same-origin writes", () => {
  test("a write without an Origin, or from another site, is refused; reads are not writes", async () => {
    const cookie = await signIn(`csrf@${CUST}`);
    const none = await call(requestsRoute.POST, "/support/api/requests", { cookie, origin: null, form: form({ request_type_id: String(typeIds.bug), subject: "x", body: "y", answers: "{}" }) });
    assert.equal(none.status, 403);
    const foreign = await call(requestsRoute.POST, "/support/api/requests", { cookie, origin: "https://evil.example", form: form({ request_type_id: String(typeIds.bug), subject: "x", body: "y", answers: "{}" }) });
    assert.equal(foreign.status, 403);
    const nullOrigin = await call(linkRoute.POST, "/support/api/link", { origin: "null", json: { email: `n@${CUST}` } });
    assert.equal(nullOrigin.status, 403);
    const fetchSite = await call(requestsRoute.POST, "/support/api/requests", { cookie, origin: null, secFetch: "same-origin", form: form({ request_type_id: String(typeIds.bug), subject: "fetch site", body: "y", answers: "{}" }) });
    assert.equal(fetchSite.status, 201, "Sec-Fetch-Site: same-origin stands in for a missing Origin");
    const signOut = await call(sessionRoute.DELETE, "/support/api/session", { method: "DELETE", cookie, origin: "https://evil.example" });
    assert.equal(signOut.status, 403);
  });
});

// --- Notices and inbound ---------------------------------------------------------------------

/** An inbound mail as the providers' parsers hand it over. */
function inboundEmail(over: Partial<InboundEmail>): InboundEmail {
  return {
    provider: "generic",
    from: { email: "", name: "" },
    to: [{ email: `help@${STAMP}.corp.test`, name: "" }],
    cc: [],
    recipients: [],
    subject: "",
    text: "",
    html: "",
    stripped: "",
    messageId: `${newToken()}@mail.example.test`,
    inReplyTo: "",
    references: [],
    headers: {},
    files: [],
    ...over,
  } as InboundEmail;
}

describe("notices and email replies", () => {
  test("received and reply notices go by email with a portal link and the agent's first name", async () => {
    const addr = `notice@${CUST}`;
    const cookie = await signIn(addr);
    const n = mail.length;
    const a = await raise(cookie, typeIds.bug, `${STAMP} notify me`);
    const received = mail.slice(n).find((m) => m.to === addr && /received/i.test(m.subject));
    assert.ok(received, "the receipt went to the contact");
    assert.ok(received!.text.includes(`/support/requests/${a.body.number}`), "a link back into the portal");
    assert.ok(!received!.text.includes("/help/requests"), "never a Get help link");
    const t = await ticketOf(a.body.number);
    const m2 = mail.length;
    await messages.addMessage(t.id, { kind: "public", body: "Fixed it on our side.", author: { id: agent.id, name: "Priya Shah", email: "" }, via: "desk" });
    await settle();
    const reply = mail.slice(m2).find((m) => m.to === addr);
    assert.ok(reply, "the reply notice went to the contact");
    assert.ok(reply!.text.includes("Priya"));
    assert.ok(!reply!.text.includes("Shah"), "first name only");
    assert.ok(reply!.text.includes(`/support/requests/${a.body.number}`));
    const bells = await pool().query("SELECT 1 FROM notifications WHERE link LIKE $1", [`%/support/requests/${a.body.number}`]);
    assert.equal(bells.rows.length, 0, "no bell");
  });


  test("an emailed reply from the contact threads into their portal ticket with Outside senders off; nobody else's does", async () => {
    const addr = `mailer@${CUST}`;
    const cookie = await signIn(addr);
    const a = await raise(cookie, typeIds.bug, `${STAMP} by email too`);
    const t = await ticketOf(a.body.number);
    const token = await email.ensureReplyToken(t.id);
    const subject = `Re: [#${t.number} ref:${token}]`;
    const ok = await inbound.processInboundEmail(inboundEmail({ from: { email: addr, name: "Jordan" }, subject, text: "Adding a detail by email.", auth: { dmarc: "pass" } } as never), {
      outsideSenders: false,
      trustUnverified: false,
    });
    assert.equal(ok.body.outcome, "appended", JSON.stringify(ok.body));
    const stranger = await inbound.processInboundEmail(inboundEmail({ from: { email: `stranger@${OTHER}`, name: "" }, subject, text: "I'm not them.", auth: { dmarc: "pass" } } as never), {
      outsideSenders: false,
      trustUnverified: false,
    });
    assert.notEqual(stranger.body.outcome, "appended");
    const unverified = await inbound.processInboundEmail(inboundEmail({ from: { email: addr, name: "" }, subject, text: "forged", auth: { spf: "fail", dkim: "none" } } as never), {
      outsideSenders: false,
      trustUnverified: false,
    });
    assert.notEqual(unverified.body.outcome, "appended", "the sender check still decides first");
    const bodies = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1", [t.id])).rows.map((r) => r.body).join("\n");
    assert.ok(bodies.includes("Adding a detail by email."));
    assert.ok(!bodies.includes("not them") && !bodies.includes("forged"));

    // A blocked contact's mail is refused, reply or new ticket.
    const c = await portal.getContactByEmail(addr);
    await portal.setContactBlocked(c!.id, true);
    const refused = await inbound.processInboundEmail(inboundEmail({ from: { email: addr, name: "" }, subject, text: "after the block", auth: { dmarc: "pass" } } as never), {
      outsideSenders: true,
      trustUnverified: false,
    });
    assert.equal(refused.body.outcome, "rejected_outside_sender");
    await portal.setContactBlocked(c!.id, false);
  });
});

// --- 1.19.1 review fixes ---------------------------------------------------------------------

describe("review fixes", () => {
  const EVIL = "evil.example";

  /** A request as a stranger would forge it: Host, X-Forwarded-Host and Origin all theirs. */
  async function forged<P extends Record<string, string> | undefined>(handler: (req: Request, ctx: any) => Promise<Response>, url: string, o: Opts = {}, params?: P) {
    const base = await makeRequest(url, o);
    const h = new Headers(base.headers);
    h.set("host", EVIL);
    h.set("x-forwarded-host", EVIL);
    h.set("x-forwarded-proto", "https");
    h.set("origin", `https://${EVIL}`);
    const body = base.method === "GET" ? undefined : Buffer.from(await base.arrayBuffer());
    if (body) h.set("content-length", String(body.length));
    currentRequest = new Request(`https://${EVIL}${url}`, { method: base.method, headers: h, body });
    try {
      return await respond(await handler(currentRequest, params ? { params: Promise.resolve(params) } : undefined));
    } finally {
      currentRequest = null;
    }
  }

  test("a stranger's Host never becomes the origin later helpdesk mail links to", async () => {
    email.rememberOrigin("https://app.compass.example.test");
    const domain = (await (await import("../src/lib/settings-store")).getAppSettings()).custom_domain;
    const addr = `forger@${CUST}`;
    const n = mail.length;
    links.delete(addr);
    const r = await forged(linkRoute.POST, "/support/api/link", { json: { email: addr } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 40 && !links.has(addr); i++) await settle(50);
    assert.ok(links.has(addr), "the link was mailed");
    // The sign-in route is not forged here: the cookie comes back the usual way.
    const token = new URL(links.get(addr)!).searchParams.get("token")!;
    const sess = await call(sessionRoute.POST, "/support/api/session", { json: { token } });
    const cookie = portalCookie(/compass_portal=([^;]+)/.exec(sess.headers.get("set-cookie") ?? "")![1]);
    const raised = await forged(requestsRoute.POST, "/support/api/requests", { cookie, form: form({ request_type_id: String(typeIds.bug), subject: `${STAMP} forged host`, body: "Hello", answers: "{}" }) });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const replied = await forged(replyRoute.POST, `/support/api/requests/${raised.body.number}/messages`, { cookie, form: form({ body: "More." }) }, { number: String(raised.body.number) });
    assert.equal(replied.status, 201, JSON.stringify(replied.body));
    await settle();
    const later = await email.helpdeskOrigin();
    assert.ok(!later.includes(EVIL), `the remembered origin stays trusted (got ${later})`);
    assert.equal(later, domain ? `https://${domain}` : "https://app.compass.example.test");
    // Only the sign-in link itself may follow the request's Host (no domain set); nothing after it does.
    const after = mail.slice(n).filter((m) => !m.text.includes("/support/signin?token="));
    assert.ok(after.length > 0, "notices went out");
    for (const m of after) assert.ok(!`${m.text}${m.html}`.includes(EVIL), `no link to the forged host in "${m.subject}" to ${m.to}`);
  });

  test("a merged portal request says where it went, the kept one opens, files follow, and email replies land there", async () => {
    const addr = `merged@${CUST}`;
    const cookie = await signIn(addr);
    const note = Buffer.from("router serial 12345\n");
    const p = await raise(cookie, typeIds.bug, `${STAMP} portal duplicate`, "From the portal.", [{ name: "serial.txt", data: note }]);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const kept = await tickets.createTicket({
      subject: `${STAMP} emailed in`,
      body: "From my mailbox.",
      requester: { id: null, name: "Merged Customer", email: addr },
      via: "email",
      source: "email",
      team_id: teamId,
    });
    const n = mail.length;
    const res = await merge.mergeTickets({ id: agent.id, role: "viewer" as never, name: "Priya Shah" }, { keep: kept.number, merge: [p.body.number], notify: true });
    assert.equal(res.merged.length, 1);
    await settle(600);
    const notice = mail.slice(n).find((m) => m.to === addr && /joined/i.test(m.subject));
    assert.ok(notice, "the contact is told by email");
    assert.ok(notice!.text.includes(`/support/requests/${kept.number}`), "with a portal link to the kept request");
    assert.ok(!notice!.text.includes("/help/requests"));

    const list = await call(requestsRoute.GET, "/support/api/requests", { cookie });
    const mine = list.body.requests.find((r: any) => r.number === p.body.number);
    assert.equal(mine.status_label, `Joined with #${kept.number}`);
    assert.ok(list.body.requests.some((r: any) => r.number === kept.number), "the kept request is listed");
    const old = await portal.contactRequestDetail((await portal.getContactByEmail(addr))!, p.body.number);
    assert.equal(old!.joined_into, kept.number);
    assert.equal(old!.can_reply, false);
    const keptView = await call(requestRoute.GET, `/support/api/requests/${kept.number}`, { cookie }, { number: String(kept.number) });
    assert.equal(keptView.status, 200);
    const msgs = keptView.body.request?.messages ?? keptView.body.messages;
    assert.ok(msgs.some((m: any) => m.mine && /From the portal/.test(m.body)), "their own moved message shows as theirs");
    const fileId = msgs.flatMap((m: any) => m.attachments).find((a: any) => a.name === "serial.txt")?.id;
    assert.ok(fileId, "the moved file is listed");
    const file = await call(filesRoute.GET, `/support/api/files/${fileId}`, { cookie }, { id: String(fileId) });
    assert.equal(file.status, 200, "and downloads");
    const stranger = await signIn(`notmerged@${CUST}`);
    assert.equal((await call(requestRoute.GET, `/support/api/requests/${kept.number}`, { cookie: stranger }, { number: String(kept.number) })).status, 404);
    const replyHere = await call(replyRoute.POST, `/support/api/requests/${p.body.number}/messages`, { cookie, form: form({ body: "Hello?" }) }, { number: String(p.body.number) });
    assert.equal(replyHere.status, 409);
    assert.match(replyHere.body.error, new RegExp(`#${kept.number}`));

    // An emailed reply on the merged request's thread, Outside senders off.
    const t = await ticketOf(p.body.number);
    const token = await email.ensureReplyToken(t.id);
    const out = await inbound.processInboundEmail(
      inboundEmail({ from: { email: addr, name: "" }, subject: `Re: [#${t.number} ref:${token}]`, text: "Replying to the old thread.", auth: { dmarc: "pass" } } as never),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(out.body.outcome, "appended", JSON.stringify(out.body));
    assert.equal(out.body.ticket, kept.number, "on the kept ticket");
  });

  test("portal email authority and notices stop when the portal is off or the domain is blocked", async () => {
    const dom = `bd.${STAMP}.test`;
    const addr = `bob@${dom}`;
    const cookie = await signIn(addr);
    const a = await raise(cookie, typeIds.bug, `${STAMP} domain later blocked`);
    const t = await ticketOf(a.body.number);
    const token = await email.ensureReplyToken(t.id);
    const subject = `Re: [#${t.number} ref:${token}]`;
    for (const over of [{ blocked_domains: [dom] }, { access: "domains" as const, domains: [CUST] }, { enabled: false }]) {
      await useSettings(settings(over));
      try {
        const r = await inbound.processInboundEmail(inboundEmail({ from: { email: addr, name: "" }, subject, text: `blocked ${JSON.stringify(over)}`, auth: { dmarc: "pass" } } as never), {
          outsideSenders: false,
          trustUnverified: false,
        });
        assert.notEqual(r.body.outcome, "appended", `refused with ${JSON.stringify(over)}`);
        const n = mail.length;
        await messages.addMessage(t.id, { kind: "public", body: "An update.", author: { id: agent.id, name: "Priya Shah", email: "" }, via: "desk" });
        await settle();
        const got = mail.slice(n).find((m) => m.to === addr);
        if (got) assert.ok(!got.text.includes("/support/requests/"), "no dead portal link");
      } finally {
        await useSettings(settings());
      }
    }
  });

  test("an emailed follow-up to a closed portal request opens a portal request the contact can see", async () => {
    const addr = `followup@${CUST}`;
    const cookie = await signIn(addr);
    const a = await raise(cookie, typeIds.bug, `${STAMP} long done`);
    const t = await ticketOf(a.body.number);
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now(), solved_at = now() WHERE id = $1", [t.id]);
    const token = await email.ensureReplyToken(t.id);
    const n = mail.length;
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: addr, name: "Fol Low" }, subject: `Re: [#${t.number} ref:${token}]`, text: "It's broken again.", auth: { dmarc: "pass" } } as never),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r.body.outcome, "follow_up", JSON.stringify(r.body));
    const f = await ticketOf(r.body.ticket!);
    const c = await portal.getContactByEmail(addr);
    assert.equal(f.portal_contact_id, c!.id);
    assert.equal(f.source, "portal_external");
    const list = await call(requestsRoute.GET, "/support/api/requests", { cookie });
    assert.ok(list.body.requests.some((x: any) => x.number === f.number), "listed in the portal");
    await settle();
    const received = mail.slice(n).find((m) => m.to === addr);
    assert.ok(received?.text.includes(`/support/requests/${f.number}`), "the receipt links into the portal");
  });

  // 1.19.4 review (C7): a reply to a portal request in the recycle bin is a portal follow-up, as for a
  // closed one, whatever Outside senders says, and it never names the binned request.
  test("an emailed reply to a binned portal request opens a portal request that never names it", async () => {
    const addr = `binned@${CUST}`;
    const cookie = await signIn(addr);
    const a = await raise(cookie, typeIds.bug, `${STAMP} printer jams`);
    const t = await ticketOf(a.body.number);
    const token = await email.ensureReplyToken(t.id);
    await pool().query("UPDATE hd_tickets SET deleted_at = now(), deleted_by_name = 'Priya Shah' WHERE id = $1", [t.id]);
    const r = await inbound.processInboundEmail(
      inboundEmail({
        from: { email: addr, name: "Bin Ned" },
        subject: `Re: [#${t.number} ref:${token}]`,
        text: "Still jamming.\n\nOn Mon, Support wrote:\n> Your request was received.",
        auth: { dmarc: "pass" },
      } as never),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r.body.outcome, "follow_up", JSON.stringify(r.body));
    assert.notEqual(r.body.ticket, t.number);
    const f = await ticketOf(r.body.ticket!);
    assert.equal(f.portal_contact_id, (await portal.getContactByEmail(addr))!.id);
    assert.equal(f.source, "portal_external");
    assert.equal(f.source_ref?.follow_up_of, undefined, "never the binned number");
    const body = (await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind <> 'system' ORDER BY id LIMIT 1", [f.id])).rows[0].body as string;
    assert.ok(!body.includes(`#${t.number}`), body);
    assert.ok(!body.includes("Your request was received"), "the quoted thread stays out");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%Still jamming%'", [t.id])).rows[0].n, 0, "nothing lands on the binned one");
    const list = await call(requestsRoute.GET, "/support/api/requests", { cookie });
    assert.ok(list.body.requests.some((x: any) => x.number === f.number), "the follow-up shows in the portal");
    assert.ok(!list.body.requests.some((x: any) => x.number === t.number), "the binned one doesn't");
  });

  test("plus-addressing shares the mailbox's link limit and its block", async () => {
    await useSettings(settings({ limits: { links_per_email_hour: 2, requests_per_email_hour: 5 } }));
    try {
      const base = `plus-${Date.now()}`;
      assert.equal(await portal.deliverSignInLink(`${base}@${CUST}`, { origin: ORIGIN }), "sent");
      assert.equal(await portal.deliverSignInLink(`${base}+a@${CUST}`, { origin: ORIGIN }), "sent");
      assert.equal(await portal.deliverSignInLink(`${base}+b@${CUST}`, { origin: ORIGIN }), "limited", "the third link to one mailbox");
    } finally {
      await useSettings(settings());
    }
    const victim = `victim-${Date.now()}`;
    const variantCookie = await signIn(`${victim}+old@${CUST}`);
    await portal.deliverSignInLink(`${victim}@${CUST}`, { origin: ORIGIN });
    const c = await portal.getContactByEmail(`${victim}@${CUST}`);
    await portal.setContactBlocked(c!.id, true);
    assert.equal(await portal.deliverSignInLink(`${victim}+new@${CUST}`, { origin: ORIGIN }), "blocked");
    assert.equal((await call(requestsRoute.GET, "/support/api/requests", { cookie: variantCookie })).status, 401, "a variant's session stops too");
    assert.equal(await portal.isBlockedPortalMailbox(`${victim.toUpperCase()}+x@${CUST}`), true);
    assert.equal(portal.canonicalMailbox(`Bob+tag@X.com`), "bob@x.com");
  });
});

// --- The sweep -----------------------------------------------------------------------------

describe("housekeeping", () => {
  test("the sweep removes expired sessions and stale links, and never a contact with requests", async () => {
    const addr = `sweep@${CUST}`;
    const cookie = await signIn(addr);
    await raise(cookie, typeIds.bug, `${STAMP} keep me`);
    const c = await portal.getContactByEmail(addr);
    await pool().query("UPDATE hd_portal_sessions SET expires_at = now() - interval '1 minute' WHERE contact_id = $1", [c!.id]);
    await pool().query("UPDATE hd_portal_links SET expires_at = now() - interval '2 days' WHERE contact_id = $1", [c!.id]);
    await portal.sweepPortal();
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_portal_sessions WHERE contact_id = $1", [c!.id])).rows[0].n, 0);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_portal_links WHERE contact_id = $1", [c!.id])).rows[0].n, 0);
    assert.ok(await portal.getContact(c!.id), "the contact stays");
  });
});

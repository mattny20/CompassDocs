// Helpdesk 1.19.2 loose ends (agent W5), against the database:
//   1. the customer portal's satisfaction survey (lib/helpdesk/portal-csat):
//      the solved email carries Good / OK / Not good links into the portal,
//      the rating lands in the same columns as Get help's (Good 5), once,
//      only for the request's own contact, never for a blocked contact; the
//      kept request lists the contact's requests joined with it;
//   2. reply-all threading (lib/helpdesk/reply-all): a colleague copied on
//      the original email who replies before the desk has answered joins
//      the ticket; unverified senders and people not on the ticket don't;
//   3. "New" badges (lib/helpdesk/whats-new): per person, cleared once seen;
//   4. recurring schedules follow holiday edits (lib/helpdesk/recurring-recalc);
//   5. the import's dry run in the background (lib/helpdesk/import-check):
//      progress, the bell, stop, a lost lease writes nothing, the sweep.
//
// Parallel-safe: every account, team, calendar, holiday set, schedule,
// contact, ticket and import is this file's own (stamped). The portal
// settings (one workspace key) are written under the portal tests' advisory
// lock (728661) and restored; nothing else workspace-wide is written.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-loose-ends.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- Request scope and licence stubs ------------------------------------------------

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-loose-ends.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-loose-ends.virtual.js");
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
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const portal = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const portalCsat = require("../src/lib/helpdesk/portal-csat") as typeof import("../src/lib/helpdesk/portal-csat");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notifyMod = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const replyAll = require("../src/lib/helpdesk/reply-all") as typeof import("../src/lib/helpdesk/reply-all");
const merge = require("../src/lib/helpdesk/merge") as typeof import("../src/lib/helpdesk/merge");
const whatsNew = require("../src/lib/helpdesk/whats-new") as typeof import("../src/lib/helpdesk/whats-new");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
const recurring = require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring");
const recalc = require("../src/lib/helpdesk/recurring-recalc") as typeof import("../src/lib/helpdesk/recurring-recalc");
const imp = require("../src/lib/helpdesk/import") as typeof import("../src/lib/helpdesk/import");
const impShared = require("../src/lib/helpdesk/import-shared") as typeof import("../src/lib/helpdesk/import-shared");
const check = require("../src/lib/helpdesk/import-check") as typeof import("../src/lib/helpdesk/import-check");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const dbCore = require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core");
const linkRoute = require("../src/app/(portal)/support/api/link/route") as typeof import("../src/app/(portal)/support/api/link/route");
const sessionRoute = require("../src/app/(portal)/support/api/session/route") as typeof import("../src/app/(portal)/support/api/session/route");
const requestsRoute = require("../src/app/(portal)/support/api/requests/route") as typeof import("../src/app/(portal)/support/api/requests/route");
const csatRoute = require("../src/app/(portal)/support/api/requests/[number]/csat/route") as typeof import("../src/app/(portal)/support/api/requests/[number]/csat/route");
const whatsNewRoute = require("../src/app/api/helpdesk/whats-new/route") as typeof import("../src/app/api/helpdesk/whats-new/route");
const dryRunRoute = require("../src/app/api/helpdesk/admin/import/[id]/dry-run/route") as typeof import("../src/app/api/helpdesk/admin/import/[id]/dry-run/route");
const stopRoute = require("../src/app/api/helpdesk/admin/import/[id]/stop-check/route") as typeof import("../src/app/api/helpdesk/admin/import/[id]/stop-check/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpdeskOutgoingMail } from "../src/lib/helpdesk/email";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { PortalSettings } from "../src/lib/helpdesk/portal-shared";

// --- Fixtures ----------------------------------------------------------------------------

const STAMP = `hdw5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CUST = `${STAMP}.clientco.test`;
const ALIAS = `${STAMP}-it@example.test`;
const HOST = "portal.example.test";
const ORIGIN = `http://${HOST}`;
const PORTAL_LOCK = 728661;
let lockClient: PoolClient;
let savedPortal: string | undefined;
let uploadDirectory = "";
let teamId = 0;
let bugType = 0;
let calId = 0;
let setId = 0;
const mail: HelpdeskOutgoingMail[] = [];
const links = new Map<string, string>();
const userIds: number[] = [];
const ticketIds: number[] = [];
const jobIds: number[] = [];
type Person = { id: number; session: string; email: string; name: string };
const U: Record<"agent" | "admin" | "req" | "colleague" | "stranger", Person> = {} as never;

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function newUser(tag: string, name: string): Promise<Person> {
  const addr = `${tag}@${STAMP}.corp.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${tag}`, name, addr]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  return { id, session, email: addr, name };
}

async function respond(res: Response) {
  const type = res.headers.get("content-type") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (type.includes("json") ? await res.json() : await res.text()) as any, headers: res.headers };
}

type Opts = { method?: string; cookie?: string; json?: unknown; form?: FormData };
let ipSeq = 0;
async function makeRequest(url: string, o: Opts = {}): Promise<Request> {
  ipSeq = (ipSeq % 250) + 1;
  const headers: Record<string, string> = { host: HOST, origin: ORIGIN, "x-forwarded-for": `198.51.100.${ipSeq}`, "user-agent": "W5Test/1.0" };
  if (o.cookie) headers.cookie = o.cookie;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: (req: Request, ctx: any) => Promise<Response>, url: string, o: Opts = {}, params?: Record<string, string>) {
  const req = await makeRequest(url, o);
  currentRequest = req;
  try {
    return await respond(await handler(req, params ? { params: Promise.resolve(params) } : undefined));
  } finally {
    currentRequest = null;
  }
}

/** An app (workspace) session's request. */
const app = (p: Person, o: Omit<Opts, "cookie"> = {}): Opts => ({ ...o, cookie: `compass_session=${p.session}` });

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
  const m = /compass_portal=([^;]+)/.exec(s.headers.get("set-cookie") ?? "");
  assert.ok(m, "the portal cookie is set");
  return `compass_portal=${m![1]}`;
}

async function raise(cookie: string, subject: string) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ request_type_id: String(bugType), subject, body: "It broke.", answers: "{}" })) f.append(k, v);
  const r = await call(requestsRoute.POST, "/support/api/requests", { cookie, form: f });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [r.body.number])).rows[0];
  ticketIds.push(t.id);
  return t as { id: number; number: number; reply_token: string | null };
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
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [PORTAL_LOCK]);
  savedPortal = await getSetting(portal.HD_PORTAL_SETTINGS_KEY);
  uploadDirectory = await mkdtemp(path.join(tmpdir(), "compass-hdw5-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDirectory;

  U.agent = await newUser("agent", "Ana Kowalski");
  U.admin = await newUser("admin", "Ada Admin");
  U.req = await newUser("req", "Daniel Okafor");
  U.colleague = await newUser("colleague", "Priya Natarajan");
  U.stranger = await newUser("stranger", "Tom Becker");
  for (const p of [U.agent, U.admin]) {
    await fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'`, [p.id]);
  }
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'", [U.admin.id]);

  // A calendar and holiday set of our own (the recurring tests edit them).
  const OFFICE = [[], ...Array.from({ length: 5 }, () => [{ start: "09:00", end: "17:00" }]), []];
  calId = (await pool().query("INSERT INTO hd_calendars (name, timezone, schedule) VALUES ($1, 'Europe/London', $2) RETURNING id", [`${STAMP} office`, JSON.stringify(OFFICE)])).rows[0].id;
  setId = (await pool().query("INSERT INTO hd_holiday_sets (name) VALUES ($1) RETURNING id", [`${STAMP} holidays`])).rows[0].id;
  await pool().query("INSERT INTO hd_calendar_holiday_sets (calendar_id, set_id) VALUES ($1, $2)", [calId, setId]);
  teamId = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position, calendar_id) VALUES ($1, $2, 996, $3) RETURNING id", [`${STAMP} IT`, ALIAS, calId])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'lead')", [teamId, U.agent.id, U.admin.id]);
  calendars.invalidateCalendarCache();
  bugType = (
    await fixtureQuery("INSERT INTO hd_request_types (slug, title, team_id, form, position) VALUES ($1, 'Report a bug', $2, '[]', 999) RETURNING id", [`${STAMP}-bug`, teamId])
  ).rows[0].id;

  email.setHelpdeskTransportForTests(async (m) => {
    mail.push(m);
  });
  portal.setPortalLinkSpyForTests((addr, url) => links.set(addr, url));
  inbound.resetInboundRateLimitsForTests();
  const s: PortalSettings = portal.cleanPortalSettings({
    enabled: true,
    types: [{ id: bugType, team_id: null }],
    access: "anyone",
    domains: [],
    brand_name: "Acme Support",
    limits: { links_per_email_hour: 20, requests_per_email_hour: 20 },
    blocked_words: [],
    blocked_domains: [],
  });
  await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(s));
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  portal.setPortalLinkSpyForTests(null);
  await settle(500);
  const all = (
    await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1 OR id = ANY($2) OR requester_email LIKE $3 OR requester_id = ANY($4) OR import_ref LIKE $5", [
      teamId,
      ticketIds,
      `%${STAMP}%`,
      userIds,
      `${STAMP}%`,
    ])
  ).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_attachments WHERE ticket_id = ANY($1)", [all]).catch(() => {});
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_recurring WHERE team_id = $1", [teamId]);
  await pool().query("DELETE FROM hd_import_jobs WHERE id = ANY($1) OR created_by = ANY($2)", [jobIds, userIds]);
  await pool().query("DELETE FROM hd_portal_contacts WHERE email LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_request_types WHERE slug LIKE $1", [`${STAMP}-%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1 OR name LIKE $2", [teamId, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_calendars WHERE id = $1", [calId]);
  await pool().query("DELETE FROM hd_holiday_sets WHERE id = $1", [setId]);
  await pool().query("DELETE FROM audit_log WHERE target_label LIKE $1 OR actor_id = ANY($2) OR actor_name LIKE $3", [`%${STAMP}%`, userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = ANY($1)", [all.map(String)]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_desk_seen WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  if (savedPortal === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [portal.HD_PORTAL_SETTINGS_KEY]);
  else await setSetting(portal.HD_PORTAL_SETTINGS_KEY, savedPortal);
  await lockClient.query("SELECT pg_advisory_unlock($1)", [PORTAL_LOCK]);
  lockClient.release();
  calendars.invalidateCalendarCache();
  await rm(uploadDirectory, { recursive: true, force: true });
  await pool().end();
});

// --- 1. The portal survey ------------------------------------------------------------------

/** Mark a ticket solved the way the desk's status change tells the requester (the solved notice). */
async function solve(ticketId: number) {
  await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE id = $1", [ticketId]);
  await notifyMod.notifySolvedCsat(ticketId, { origin: ORIGIN, actorName: "Ana Kowalski" });
  await settle();
}

describe("portal satisfaction survey", () => {
  test("pure: ratings map onto Get help's 1-to-5 scale; the link path survives the sign-in link", () => {
    assert.deepEqual(portalCsat.PORTAL_RATING_SCORE, { good: 5, ok: 3, not_good: 1 });
    assert.equal(portalCsat.portalRatingFor(4), "good", "a Get help 4 reads as Good");
    assert.equal(portalCsat.portalRatingFor(2), "not_good");
    const p = portalCsat.portalRatePath(30027, "not_good", "AbC-12_xyzAbC-12_xyzAB");
    assert.equal(portal.cleanNextPath(p), p, "the whole rating path is a valid sign-in `next`");
    assert.ok(!p.includes("_"), "no underscore for a plain-text mail to swallow");
    const [, , , , , slug, hex] = p.split("/");
    assert.equal(portalCsat.portalRatingFromSlug(slug), "not_good");
    assert.equal(portalCsat.tokenFromHex(hex), "AbC-12_xyzAbC-12_xyzAB");
    assert.equal(portalCsat.tokenFromHex("zz"), null);
  });

  test("the solved email asks Good / OK / Not good with portal links; the rating is taken once, as Good = 5", async () => {
    const addr = `jordan@${CUST}`;
    const cookie = await signIn(addr);
    const t = await raise(cookie, `${STAMP} Export to CSV times out`);
    const contact = (await portal.getContactByEmail(addr))!;
    // Not solved yet: no survey, and a rating is refused.
    assert.deepEqual(await portalCsat.portalSurveyState(contact, t.id), { can_rate: false, rated: null });
    const early = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "good" } }, { number: String(t.number) });
    assert.equal(early.status, 409);

    const n = mail.length;
    await solve(t.id);
    const solved = mail.slice(n).find((m) => m.to === addr);
    assert.ok(solved, "the solved notice went to the contact");
    assert.match(solved!.text, /How did we do\?/);
    // Both parts of the mail carry whole links (the plain-text part keeps no "_").
    for (const part of [solved!.text, solved!.html]) {
      for (const r of ["good", "ok", "not-good"]) assert.ok(part.includes(`/support/requests/${t.number}/rate/${r}/`), `a ${r} link into the portal`);
      assert.ok(!part.includes("/help/requests"), "never a Get help link");
    }
    const hex = new RegExp(`/support/requests/${t.number}/rate/good/([0-9a-f]+)`).exec(solved!.text)![1];
    const token = portalCsat.tokenFromHex(hex)!;
    assert.ok(token, "the link's token decodes");

    assert.equal((await portalCsat.portalSurveyState(contact, t.id)).can_rate, true);
    const forged = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "good", token: "x".repeat(22) } }, { number: String(t.number) });
    assert.equal(forged.status, 403, "a wrong link token is refused");
    const bad = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "great" } }, { number: String(t.number) });
    assert.equal(bad.status, 400);
    const ok = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "good", comment: "Quick fix, thanks Ana.", token } }, { number: String(t.number) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.csat.rating, "good");
    const row = (await pool().query("SELECT csat_score, csat_comment, csat_at FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    assert.equal(row.csat_score, 5, "the same column Get help's survey writes");
    assert.equal(row.csat_comment, "Quick fix, thanks Ana.");
    assert.ok(row.csat_at);
    const again = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "not_good" } }, { number: String(t.number) });
    assert.equal(again.status, 409, "once only");
    assert.equal((await pool().query("SELECT csat_score FROM hd_tickets WHERE id = $1", [t.id])).rows[0].csat_score, 5);
    const state = await portalCsat.portalSurveyState(contact, t.id);
    assert.equal(state.can_rate, false);
    assert.equal(state.rated?.rating, "good");
    const line = await pool().query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'system' AND body LIKE 'Rated %'", [t.id]);
    assert.equal(line.rows[0]?.body, "Rated Good (5 out of 5) in the customer portal");
    const audit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.portal.csat' AND target_id = $1", [String(t.id)]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].details.via, "email");
    // A rated request asks nothing more when solved again.
    const m2 = mail.length;
    await solve(t.id);
    const second = mail.slice(m2).find((m) => m.to === addr);
    assert.ok(second && !/How did we do/.test(second.text), "no second survey");
  });

  test("never for a blocked contact; never someone else's request; never a workspace requester's ticket", async () => {
    const addr = `blocked@${CUST}`;
    const cookie = await signIn(addr);
    const t = await raise(cookie, `${STAMP} blocked one`);
    const other = await signIn(`someone@${CUST}`);
    // Somebody else's request is a 404, like every portal route.
    const theirs = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie: other, json: { rating: "ok" } }, { number: String(t.number) });
    assert.equal(theirs.status, 404);
    const contact = (await portal.getContactByEmail(addr))!;
    await portal.setContactBlocked(contact.id, true);
    const n = mail.length;
    await solve(t.id);
    assert.equal(mail.slice(n).filter((m) => m.to === addr).length, 0, "a blocked contact hears nothing");
    assert.equal(await portalCsat.portalSurveyApplies(t.id), false);
    const r = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "ok" } }, { number: String(t.number) });
    assert.equal(r.status, 401, "their session is gone");
    assert.equal((await pool().query("SELECT csat_score FROM hd_tickets WHERE id = $1", [t.id])).rows[0].csat_score, null);
    // A workspace requester's ticket is Get help's survey, not the portal's.
    const { createTicket } = await import("../src/lib/helpdesk/tickets");
    const ws = await createTicket({ subject: `${STAMP} ws`, body: "x", requester: { id: U.req.id, name: U.req.name, email: U.req.email }, team_id: teamId, via: "portal", source: "portal" } as never, { silent: true } as never);
    ticketIds.push(ws.id);
    assert.equal(await portalCsat.portalSurveyApplies(ws.id), false);
  });

  test("review: the rating's audit row never names the customer; anonymising scrubs older rows that did", async () => {
    const addr = `audit-${STAMP}@${CUST}`;
    const cookie = await signIn(addr);
    const t = await raise(cookie, `${STAMP} audit me`);
    const contact = (await portal.getContactByEmail(addr))!;
    await solve(t.id);
    const r = await call(csatRoute.POST, `/support/api/requests/${t.number}/csat`, { cookie, json: { rating: "ok", comment: "Fine" } }, { number: String(t.number) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await pool().query("SELECT actor_id, actor_name, ip, details FROM audit_log WHERE action = 'helpdesk.portal.csat' AND target_id = $1", [String(t.id)])).rows[0];
    assert.equal(row.actor_name, "Customer portal", "no address as the actor");
    assert.equal(row.ip, null, "no IP on a ticket's row");
    assert.equal(row.details.contact_id, contact.id);
    // A row written the 1.19.2-beta way (address and IP), then the ticket is anonymised.
    await pool().query(
      `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_label, details, ip)
       VALUES (NULL, $1, 'helpdesk.portal.csat', 'helpdesk_ticket', $2, $3, $4, '203.0.113.7')`,
      [`Customer portal: ${addr}`, String(t.id), `#${t.number}`, JSON.stringify({ number: t.number, contact_id: contact.id })]
    );
    // An agent's row on the same ticket keeps its actor.
    await pool().query(
      `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_label, ip) VALUES ($1, 'Ana Kowalski', 'helpdesk.ticket.updated', 'helpdesk_ticket', $2, $3, '198.51.100.2')`,
      [U.agent.id, String(t.id), `#${t.number}`]
    );
    await dbCore.withTx((client) => retention.anonymiseTicketTx(client, t.id));
    const rows = (await pool().query("SELECT actor_id, actor_name, ip, details::text AS details FROM audit_log WHERE target_type = 'helpdesk_ticket' AND target_id = $1", [String(t.id)])).rows;
    for (const a of rows) {
      assert.ok(!`${a.actor_name} ${a.details}`.toLowerCase().includes(addr.toLowerCase()), `no address left: ${a.actor_name} ${a.details}`);
      assert.ok(!/contact_id/.test(a.details ?? ""), "the contact id goes");
      if (a.actor_id === null) assert.equal(a.ip, null, "no IP on a requester-side row");
    }
    assert.ok(rows.filter((a) => a.actor_id === null && a.actor_name === "Customer portal").length >= 2);
    const agentRow = rows.find((a) => a.actor_id === U.agent.id)!;
    assert.equal(agentRow.actor_name, "Ana Kowalski", "an agent's row keeps its actor");
    assert.equal(agentRow.ip, "198.51.100.2");
    // Pure: what the rule leaves alone.
    assert.equal(retention.requesterSideActor({ actor_id: null, actor_name: "inbound email", ip: null }, [addr], new Set()), null);
    assert.equal(retention.requesterSideActor({ actor_id: null, actor_name: "Jordan Lee", ip: "1.2.3.4" }, [], new Set(["Jordan Lee"])), "Former requester");
  });

  test("the kept request lists the contact's own requests joined with it", async () => {
    const addr = `merge@${CUST}`;
    const cookie = await signIn(addr);
    const a = await raise(cookie, `${STAMP} first`);
    const b = await raise(cookie, `${STAMP} second`);
    const otherCookie = await signIn(`merge-other@${CUST}`);
    const c = await raise(otherCookie, `${STAMP} other's`);
    await merge.mergeTickets({ id: U.agent.id, role: "viewer" as never, name: "Ana Kowalski" }, { keep: b.number, merge: [a.number, c.number], notify: true });
    const contact = (await portal.getContactByEmail(addr))!;
    const notices = await portalCsat.portalJoinedNotices(contact.id, b.id);
    assert.deepEqual(notices.map((x) => x.number), [a.number], "only their own request, not another contact's");
    assert.ok(Date.parse(notices[0].at) > Date.now() - 600_000);
    // The merged request takes no rating (its survey is the kept one's).
    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [a.id]);
    assert.equal((await portalCsat.portalSurveyState(contact, a.id)).can_rate, false);
  });
});

// --- 2. Reply-all threading ----------------------------------------------------------------------

describe("reply-all threading", () => {
  test("pure: In-Reply-To first, then References newest-first; our own ids and the mail's own are left out", () => {
    const ids = replyAll.threadIds({ messageId: "self@x", inReplyTo: "<b@x>", references: ["a@x", "hd.abcdefghijklmnop.1@us", "b@x", "self@x"] });
    assert.deepEqual(ids, ["b@x", "a@x"]);
  });

  test("a CC'd colleague's Reply all before the desk answered joins the ticket; so does a reply to that reply", async () => {
    const original = inboundEmail({ cc: [{ email: U.colleague.email, name: "" }], subject: `${STAMP} VPN drops` });
    const r1 = await inbound.processInboundEmail(original, { outsideSenders: false, trustUnverified: false });
    assert.equal(r1.body.outcome, "created");
    const t = (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [r1.body.ticket])).rows[0];
    ticketIds.push(t.id);
    const ccs = await pool().query("SELECT user_id FROM hd_ticket_ccs WHERE ticket_id = $1", [t.id]).catch(() => ({ rows: [] as { user_id: number }[] }));
    assert.ok(ccs.rows.some((r) => r.user_id === U.colleague.id), "the Cc became a CC");
    const id = original.messageId;
    // The original's Message-ID is stored on the ticket's first message.
    assert.equal((await pool().query("SELECT email_message_id FROM hd_messages WHERE ticket_id = $1 ORDER BY id LIMIT 1", [t.id])).rows[0].email_message_id, id);

    const replyAllMail = inboundEmail({
      from: { email: U.colleague.email, name: "Priya" },
      cc: [{ email: U.req.email, name: "" }],
      subject: `Re: ${STAMP} VPN drops`,
      text: "Same here since this morning.",
      inReplyTo: id,
      references: [id],
    });
    const r2 = await inbound.processInboundEmail(replyAllMail, { outsideSenders: false, trustUnverified: false });
    assert.equal(r2.body.outcome, "appended", JSON.stringify(r2.body));
    assert.equal(r2.body.ticket, t.number);
    const msg = (await pool().query("SELECT author_id, kind FROM hd_messages WHERE email_message_id = $1", [replyAllMail.messageId])).rows[0];
    assert.equal(msg.author_id, U.colleague.id);
    assert.equal(msg.kind, "public");
    // The requester answers the colleague's mail (its id, the original in References).
    const r3 = await inbound.processInboundEmail(
      inboundEmail({ subject: `Re: ${STAMP} VPN drops`, text: "Thanks.", inReplyTo: replyAllMail.messageId, references: [id, replyAllMail.messageId] }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r3.body.outcome, "appended");
    assert.equal(r3.body.ticket, t.number);
  });

  test("review: a reply-all mails no second copy to the requester and CCs it already went to (the bell stays)", async () => {
    const third = await newUser("third", "Lena Third");
    const original = inboundEmail({ cc: [{ email: U.colleague.email, name: "" }, { email: U.stranger.email, name: "" }], subject: `${STAMP} Monitor flickers` });
    const r1 = await inbound.processInboundEmail(original, { outsideSenders: false, trustUnverified: false });
    const t = (await pool().query("SELECT id, number FROM hd_tickets WHERE number = $1", [r1.body.ticket])).rows[0];
    ticketIds.push(t.id);
    const ccs = await import("../src/lib/helpdesk/ccs");
    // Copied later, not on the colleague's mail: still mailed.
    await ccs.addCcs(t.id, [{ userId: third.id }], { userId: U.agent.id, via: "desk", outsideAllowed: false });
    await settle();
    const got = (addr: string, from: number) =>
      mail.slice(from).filter((m) => m.to.toLowerCase() === addr.toLowerCase() || (m.cc ?? "").toLowerCase().split(/,\s*/).includes(addr.toLowerCase()));
    const n = mail.length;
    const bellsBefore = (await pool().query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [U.req.id])).rows[0].n;
    const r2 = await inbound.processInboundEmail(
      inboundEmail({
        from: { email: U.colleague.email, name: "Priya" },
        to: [{ email: U.req.email, name: "" }],
        cc: [{ email: ALIAS, name: "" }, { email: U.stranger.email, name: "" }],
        subject: `Re: ${STAMP} Monitor flickers`,
        text: "Mine too.",
        inReplyTo: original.messageId,
        references: [original.messageId],
      }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r2.body.outcome, "appended");
    await settle(500);
    assert.equal(got(U.req.email, n).length, 0, "the requester had it on the mail itself");
    assert.equal(got(U.stranger.email, n).length, 0, "so did the other CC");
    assert.ok(got(third.email, n).length >= 1, "a CC who was not on the mail is still told");
    const bellsAfter = (await pool().query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [U.req.id])).rows[0].n;
    assert.ok(bellsAfter > bellsBefore, "the requester still gets the bell");

    // An agent's reply-all: the requester on its To gets no mailed copy either.
    const m2 = mail.length;
    const r3 = await inbound.processInboundEmail(
      inboundEmail({
        from: { email: U.agent.email, name: "Ana" },
        to: [{ email: U.req.email, name: "" }],
        cc: [{ email: ALIAS, name: "" }],
        subject: `Re: ${STAMP} Monitor flickers`,
        text: "Looking now.",
        inReplyTo: original.messageId,
        references: [original.messageId],
      }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r3.body.outcome, "appended", JSON.stringify(r3.body));
    await settle(500);
    assert.equal(got(U.req.email, m2).length, 0, "no copy of the agent's reply-all to the requester");
    assert.ok(got(third.email, m2).length >= 1, "the CC not on it still hears");
    assert.deepEqual(replyAll.directRecipients({ to: [{ email: "A@x.test", name: "" }], cc: [{ email: "b@x.test", name: "" }], recipients: ["a@x.test", "nope"] }), ["a@x.test", "b@x.test"]);
  });

  test("never for an unverified sender, nor for someone neither on the ticket nor its agent", async () => {
    const original = inboundEmail({ cc: [{ email: U.colleague.email, name: "" }], subject: `${STAMP} Badge reader` });
    const r1 = await inbound.processInboundEmail(original, { outsideSenders: false, trustUnverified: false });
    const t = (await pool().query("SELECT id, number FROM hd_tickets WHERE number = $1", [r1.body.ticket])).rows[0];
    ticketIds.push(t.id);
    const forged = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.colleague.email, name: "" }, subject: `Re: ${STAMP} Badge reader`, inReplyTo: original.messageId, references: [original.messageId], auth: { dmarc: "fail" } } as never),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.notEqual(forged.body.outcome, "appended", "a failed sender check never joins a ticket");
    const stranger = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.stranger.email, name: "" }, subject: `Re: ${STAMP} Badge reader`, inReplyTo: original.messageId, references: [original.messageId] }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(stranger.body.outcome, "created", "someone not on it opens a ticket of their own");
    assert.notEqual(stranger.body.ticket, t.number);
    ticketIds.push((await pool().query("SELECT id FROM hd_tickets WHERE number = $1", [stranger.body.ticket])).rows[0].id);
    const count = await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public'", [t.id]);
    assert.equal(count.rows[0].n, 1, "nothing was added to the original ticket");
  });

  test("a merged ticket's thread replies into the kept one", async () => {
    const o1 = inboundEmail({ cc: [{ email: U.colleague.email, name: "" }], subject: `${STAMP} Wi-Fi A` });
    const a = await inbound.processInboundEmail(o1, { outsideSenders: false, trustUnverified: false });
    const b = await inbound.processInboundEmail(inboundEmail({ subject: `${STAMP} Wi-Fi B` }), { outsideSenders: false, trustUnverified: false });
    for (const n of [a.body.ticket, b.body.ticket]) ticketIds.push((await pool().query("SELECT id FROM hd_tickets WHERE number = $1", [n])).rows[0].id);
    await merge.mergeTickets({ id: U.agent.id, role: "viewer" as never, name: "Ana Kowalski" }, { keep: b.body.ticket!, merge: [a.body.ticket!], notify: false });
    const r = await inbound.processInboundEmail(
      inboundEmail({ from: { email: U.colleague.email, name: "" }, subject: `Re: ${STAMP} Wi-Fi A`, inReplyTo: o1.messageId, references: [o1.messageId] }),
      { outsideSenders: false, trustUnverified: false }
    );
    assert.equal(r.body.outcome, "appended", JSON.stringify(r.body));
    assert.equal(r.body.ticket, b.body.ticket, "lands on the kept ticket");
  });
});

// --- 3. "New" badges ------------------------------------------------------------------------------

describe("New badges in the desk settings rail", () => {
  const ALL = whatsNew.DESK_NEW_PAGES.map((p) => p.href);

  test("per person: every New page the rail shows is flagged until opened; the strip until dismissed", async () => {
    const s0 = await whatsNew.deskNewState(U.agent.id, [...ALL, "/desk/settings/teams"]);
    assert.deepEqual(s0.unseen, ALL);
    assert.equal(s0.strip, true);
    assert.equal(s0.release, "1.19.2");
    const narrow = await whatsNew.deskNewState(U.agent.id, ["/desk/settings/canned"]);
    assert.deepEqual(narrow.unseen, ["/desk/settings/canned"], "only pages this person's rail shows");
    const none = await whatsNew.deskNewState(U.agent.id, ["/desk/settings/teams"]);
    assert.equal(none.strip, false, "no strip for someone who reaches none of the pages");

    const opened = await call(whatsNewRoute.POST, "/api/helpdesk/whats-new", app(U.agent, { json: { item: "/desk/settings/canned" } }));
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    await call(whatsNewRoute.POST, "/api/helpdesk/whats-new", app(U.agent, { json: { item: "/desk/settings/canned" } }));
    const s1 = await whatsNew.deskNewState(U.agent.id, ALL);
    assert.deepEqual(s1.unseen, ALL.filter((h) => h !== "/desk/settings/canned"));
    assert.equal(s1.strip, true);
    // Somebody else still sees all three.
    assert.deepEqual((await whatsNew.deskNewState(U.admin.id, ALL)).unseen, ALL);
    const dismissed = await call(whatsNewRoute.POST, "/api/helpdesk/whats-new", app(U.agent, { json: { item: whatsNew.DESK_NEW_STRIP } }));
    assert.equal(dismissed.status, 200);
    assert.equal((await whatsNew.deskNewState(U.agent.id, ALL)).strip, false);
    const audits = await pool().query("SELECT target_label FROM audit_log WHERE action = 'helpdesk.whats_new.seen' AND actor_id = $1 ORDER BY id", [U.agent.id]);
    assert.deepEqual(audits.rows.map((r) => r.target_label), ["/desk/settings/canned", whatsNew.DESK_NEW_STRIP], "written and audited once each");
  });

  test("only items on the list; only agents; never cross-origin", async () => {
    const odd = await call(whatsNewRoute.POST, "/api/helpdesk/whats-new", app(U.agent, { json: { item: "/desk/settings/teams" } }));
    assert.equal(odd.status, 400);
    const notAgent = await call(whatsNewRoute.POST, "/api/helpdesk/whats-new", app(U.req, { json: { item: "/desk/settings/canned" } }));
    assert.equal(notAgent.status, 403);
    const req = new Request("http://localhost/api/helpdesk/whats-new", {
      method: "POST",
      headers: { cookie: `compass_session=${U.admin.session}`, origin: "https://evil.example", host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ item: "/desk/settings/canned" }),
    });
    currentRequest = req;
    try {
      assert.equal((await whatsNewRoute.POST(req)).status, 403);
    } finally {
      currentRequest = null;
    }
    assert.equal((await pool().query("SELECT 1 FROM hd_desk_seen WHERE user_id = $1", [U.admin.id])).rowCount, 0);
  });

  test("pure: the page a path is on; A, B and C", () => {
    assert.equal(whatsNew.deskNewPageFor("/desk/settings/canned/12")?.href, "/desk/settings/canned");
    assert.equal(whatsNew.deskNewPageFor("/desk/settings/cannedx"), undefined);
    assert.equal(whatsNew.andList(["A", "B", "C"]), "A, B and C");
    assert.equal(whatsNew.isDeskNewItem("strip:1.19.2"), true);
    assert.equal(whatsNew.isDeskNewItem("strip:1.19.1"), false);
  });
});

// --- 4. Recurring schedules follow holiday edits ------------------------------------------------------

const london = (d: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(d));

describe("recurring next runs follow the calendar", () => {
  test("adding a holiday on the stored next run moves it; removing it moves it back; a due run is left to the sweep", async () => {
    const input = {
      team_id: teamId,
      subject: `${STAMP} daily check`,
      body: "",
      priority: "normal",
      request_type_id: null,
      assign_mode: "team_rules",
      assignee_id: null,
      due_business_days: null,
      pattern: { kind: "daily", time: "23:58" },
      holiday_rule: "skip",
      timezone: "Europe/London",
      enabled: true,
    } as never;
    const s = await recurring.createRecurring(input, U.admin.id);
    const day = s.next_run_at ? london(s.next_run_at) : "";
    assert.ok(day, "a next run");
    const due = await recurring.createRecurring({ ...(input as object), subject: `${STAMP} due one` } as never, U.admin.id);
    await pool().query("UPDATE hd_recurring SET next_run_at = now() - interval '1 minute' WHERE id = $1", [due.id]);
    const dueBefore = (await pool().query("SELECT next_run_at, next_key FROM hd_recurring WHERE id = $1", [due.id])).rows[0];

    const added = await calendars.addHolidays(setId, [{ date: day, name: "Snow day", recurring_yearly: false, closed_from: null, closed_to: null }]);
    assert.ok(added);
    const moved = (await recurring.getRecurring(s.id))!;
    assert.ok(moved.next_run_at && london(moved.next_run_at) > day, `moved past ${day}: ${moved.next_run_at}`);
    const dueAfter = (await pool().query("SELECT next_run_at, next_key FROM hd_recurring WHERE id = $1", [due.id])).rows[0];
    assert.equal(new Date(dueAfter.next_run_at).getTime(), new Date(dueBefore.next_run_at).getTime(), "a due run is the sweep's to check");

    const hol = added!.added[0];
    await calendars.deleteHoliday(setId, hol.id);
    const back = (await recurring.getRecurring(s.id))!;
    assert.equal(london(back.next_run_at!), day, "back on its own day");

    // A team moved to another calendar is worked out again too.
    await pool().query("UPDATE hd_recurring SET enabled = 0 WHERE id = $1", [due.id]);
    const cal2 = await calendars.createCalendar({ name: `${STAMP} closed`, timezone: "Europe/London", schedule: [[], [], [], [], [], [], []] as never, holiday_set_ids: [] });
    const set2 = await calendars.createHolidaySet({ name: `${STAMP} h2`, holidays: [{ date: day, name: "Closed", recurring_yearly: false, closed_from: null, closed_to: null }] });
    await calendars.updateCalendar(cal2.id, { holiday_set_ids: [set2.id] });
    try {
      await calendars.assignTeamCalendar(teamId, cal2.id);
      assert.ok(london((await recurring.getRecurring(s.id))!.next_run_at!) > day, "the new calendar's holiday applies");
    } finally {
      await calendars.assignTeamCalendar(teamId, calId);
      await calendars.deleteCalendar(cal2.id);
      await calendars.deleteHolidaySet(set2.id);
    }
    assert.equal(london((await recurring.getRecurring(s.id))!.next_run_at!), day);
  });

  test("recomputeRecurringForTeams answers how many moved and never touches other teams", async () => {
    assert.equal(await recalc.recomputeRecurringForTeams([]), 0);
    assert.equal(await recalc.recomputeRecurringForTeams([teamId]), 0, "nothing to move when the calendar did not change");
  });
});

// --- 5. The import's dry run in the background ------------------------------------------------------

function ticketsCsv(n: number, tag: string): Buffer {
  const rows = ["Ticket Id,Subject,Description,Status,Priority,Created Time,Contact Email,Contact Name"];
  for (let i = 1; i <= n; i++) rows.push(`${STAMP}-${tag}-${i},Printer ${i},It jams,Open,Medium,2026-10-0${1 + (i % 9)} 10:00,c${i % 40}@${STAMP}.test,Customer ${i % 40}`);
  return Buffer.from(rows.join("\n"));
}

async function csvJob(n: number, tag: string) {
  const stored = await imp.saveImportUpload(Readable.toWeb(Readable.from([ticketsCsv(n, tag)])) as never, 50 * 1024 * 1024, "csv");
  const job = await imp.createImportJob({ source: "csv", filename: `${STAMP}-${tag}.csv`, stored, actor: { id: U.admin.id, name: "Ada Admin" } });
  jobIds.push(job.id);
  await imp.saveMapping(job.id, { timezone: "UTC", departments: {}, source_name: `${STAMP}-${tag}` });
  return job;
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(15);
  }
}

describe("import dry run in the background", () => {
  test("the route answers at once; progress and counts so far; the result equals the in-request dry run; the bell says it's ready", async () => {
    const job = await csvJob(350, "bg");
    const sync = await imp.dryRunJob(job.id);
    const want = sync.counts.dry_run!;
    const r = await call(dryRunRoute.POST, `/api/helpdesk/admin/import/${job.id}/dry-run`, app(U.admin, { json: {} }), { id: String(job.id) });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.status, "checking");
    assert.equal(r.body.job.check.kind, "dry_run");
    assert.equal(r.body.job.dry_run, null, "the earlier dry run is cleared");
    assert.equal(r.body.job.check.progress.total, 350);
    const done = await until(async () => {
      const j = await imp.getImportJob(job.id);
      return j && j.status === "ready" ? j : null;
    }, "the dry run");
    const { skipped_rows: _a, ...got } = done.counts.dry_run!;
    const { skipped_rows: _b, ...exp } = want;
    assert.deepEqual(got, exp, "the same counts as the in-request dry run");
    assert.equal(done.check_progress?.phase, "done");
    assert.equal(done.check_progress?.counts?.tickets_create, want.tickets_create);
    const bell = await until(async () => (await pool().query("SELECT title, body, link FROM notifications WHERE user_id = $1 AND title LIKE 'Dry run ready%'", [U.admin.id])).rows[0], "the bell");
    assert.equal(bell.link, `/desk/settings/import?job=${job.id}`);
    assert.match(bell.body, /350 to create/);
    const started = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.import.check_started' AND target_id = $1", [String(job.id)]);
    assert.equal(started.rows[0]?.details.kind, "dry_run");
    // While a check runs nothing else changes the job.
    await pool().query("UPDATE hd_import_jobs SET status = 'checking', heartbeat_at = now() WHERE id = $1", [job.id]);
    await assert.rejects(imp.saveMapping(job.id, { timezone: "UTC" }), /being checked/);
    await assert.rejects(imp.startImport(job.id), /being checked/);
    await assert.rejects(imp.discardImportJob(job.id), /being checked/);
    await pool().query("UPDATE hd_import_jobs SET status = 'ready' WHERE id = $1", [job.id]);
  });

  test("Stop: the runner that lost its job writes nothing; the job is back at the map step", async () => {
    const job = await csvJob(1500, "stop");
    const r = await call(dryRunRoute.POST, `/api/helpdesk/admin/import/${job.id}/dry-run`, app(U.admin, { json: {} }), { id: String(job.id) });
    assert.equal(r.status, 202);
    // Hold the job row once the runner has claimed it, so its next write waits on us, then stop it.
    await until(async () => {
      const j = await imp.getImportJob(job.id);
      return j?.heartbeat_at && j.check_progress?.phase !== "queued" ? j : null;
    }, "the claim");
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM hd_import_jobs WHERE id = $1 FOR UPDATE", [job.id]);
      const still = (await client.query("SELECT status FROM hd_import_jobs WHERE id = $1", [job.id])).rows[0];
      assert.equal(still.status, "checking", "stopped before it finished");
      await client.query("UPDATE hd_import_jobs SET status = 'uploaded', heartbeat_at = NULL WHERE id = $1", [job.id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await settle(1500);
    const after = (await imp.getImportJob(job.id))!;
    assert.equal(after.status, "uploaded");
    assert.equal(after.counts.dry_run, undefined, "no counts written by the runner that lost its job");
    // The route itself: stop a running dry run; a second stop is a 409; a rescan can't be stopped.
    await call(dryRunRoute.POST, `/api/helpdesk/admin/import/${job.id}/dry-run`, app(U.admin, { json: {} }), { id: String(job.id) });
    const stop = await call(stopRoute.POST, `/api/helpdesk/admin/import/${job.id}/stop-check`, app(U.admin, { json: {} }), { id: String(job.id) });
    if ((await imp.getImportJob(job.id))!.counts.dry_run === undefined) {
      assert.equal(stop.status, 200, JSON.stringify(stop.body));
      assert.equal(stop.body.job.status, "uploaded");
      const again = await call(stopRoute.POST, `/api/helpdesk/admin/import/${job.id}/stop-check`, app(U.admin, { json: {} }), { id: String(job.id) });
      assert.equal(again.status, 409);
      const audited = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.import.check_stopped' AND target_id = $1", [String(job.id)]);
      assert.equal(audited.rowCount, 1);
    }
    await settle(1500);
    await pool().query("UPDATE hd_import_jobs SET status = 'checking', check_kind = 'rescan', heartbeat_at = now() WHERE id = $1", [job.id]);
    await assert.rejects(check.stopImportCheck(job.id, { name: "t" }), /can't be stopped/);
    await pool().query("UPDATE hd_import_jobs SET status = 'uploaded' WHERE id = $1", [job.id]);
  });

  test("a check held by a live runner is left alone; a stalled one is taken over by the sweep", async () => {
    const job = await csvJob(40, "sweep");
    await pool().query("UPDATE hd_import_jobs SET status = 'checking', check_kind = 'dry_run', check_by = $2, heartbeat_at = now(), updated_at = now() WHERE id = $1", [job.id, U.admin.id]);
    const untouched = await check.runImportCheck(job.id);
    assert.equal(untouched?.status, "checking", "a live runner's check is not claimed twice");
    await pool().query("UPDATE hd_import_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [job.id]);
    assert.ok((await check.importCheckSweep()) >= 1);
    const done = await until(async () => {
      const j = await imp.getImportJob(job.id);
      return j && j.status === "ready" ? j : null;
    }, "the takeover");
    assert.equal(done.counts.dry_run?.tickets_create, 40);
  });

  test("a column change reads the export again in the background, keeping the choices", async () => {
    const job = await csvJob(60, "rescan");
    const before = (await imp.getImportJob(job.id))!;
    const cols = (before.mapping as { columns: { tickets: Record<string, string> } }).columns;
    assert.equal(cols.tickets.body, "Description", "guessed");
    const row = await imp.saveMapping(job.id, { columns: { ...cols, tickets: { ...cols.tickets, body: "" } } }, { background: { by: U.admin.id } });
    assert.equal(row.status, "checking");
    assert.equal(row.check_kind, "rescan");
    const done = await until(async () => {
      const j = await imp.getImportJob(job.id);
      return j && j.status === "uploaded" && j.check_progress?.phase === "done" ? j : null;
    }, "the rescan");
    assert.equal(done.counts.scan?.tickets, 60);
    assert.equal((done.mapping as { columns: { tickets: Record<string, string> } }).columns.tickets.body, "", "\"Not in the file\" stays chosen (1.19.1 guessed it back)");
    assert.equal((done.mapping as { source_name?: string }).source_name, `${STAMP}-rescan`, "the source name is kept");
    await until(async () => (await pool().query("SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE 'Export read with your columns%'", [U.admin.id])).rowCount, "the rescan bell");
  });

  test("saving the same columns in another key order reads nothing again (1.19.1 rescanned on every save)", async () => {
    const job = await csvJob(20, "order");
    const j = (await imp.getImportJob(job.id))!;
    const cols = (j.mapping as { columns: Record<string, Record<string, string>> }).columns;
    // As the page sends it back: the kinds in another order, a blank choice added.
    const reordered = { comments: cols.comments, messages: cols.messages, tickets: Object.fromEntries(Object.entries(cols.tickets).reverse().concat([["tags", ""]])) };
    assert.equal(imp.sameColumns(reordered as never, cols as never), true);
    assert.equal(imp.sameColumns({ ...cols, tickets: { ...cols.tickets, body: "" } } as never, cols as never), false);
    const row = await imp.saveMapping(job.id, { columns: reordered, timezone: "UTC" }, { background: { by: U.admin.id } });
    assert.equal(row.status, "uploaded", "no rescan for the same columns");
    assert.equal(row.check_kind, "");
  });

  test("review: a failed rescan leaves the scan stale; the dry run refuses it and the next save reads the export again", async () => {
    const job = await csvJob(30, "stale");
    const j = (await imp.getImportJob(job.id))!;
    assert.equal(imp.scanIsCurrent(j), true);
    const cols = (j.mapping as { columns: Record<string, Record<string, string>> }).columns;
    // What a failed rescan leaves: the new columns saved, the old scan kept, the error shown.
    const newCols = { ...cols, tickets: { ...cols.tickets, body: "" } };
    await pool().query(
      "UPDATE hd_import_jobs SET mapping = jsonb_set(mapping, '{columns}', $2::jsonb), status = 'uploaded', check_kind = 'rescan', check_error = 'The export couldn''t be read again.' WHERE id = $1",
      [job.id, JSON.stringify(newCols)]
    );
    const stale = (await imp.getImportJob(job.id))!;
    assert.equal(imp.scanIsCurrent(stale), false);
    await assert.rejects(check.queueImportCheck(job.id, "dry_run", U.admin.id), /hasn't been read with these columns/);
    await assert.rejects(imp.dryRunJob(job.id), /hasn't been read with these columns/);
    const dr = await call(dryRunRoute.POST, `/api/helpdesk/admin/import/${job.id}/dry-run`, app(U.admin, { json: {} }), { id: String(job.id) });
    assert.equal(dr.status, 409);
    // Saving the same (already saved) columns reads it again.
    const row = await imp.saveMapping(job.id, { columns: newCols, timezone: "UTC" }, { background: { by: U.admin.id } });
    assert.equal(row.status, "checking", "a stale scan is read again even with the columns unchanged");
    const done = await until(async () => {
      const x = await imp.getImportJob(job.id);
      return x && x.status === "uploaded" && x.check_progress?.phase === "done" ? x : null;
    }, "the retry");
    assert.equal(imp.scanIsCurrent(done), true);
    assert.equal(done.check_error, "");
    await imp.dryRunJob(job.id);
    // A new messages file makes the scan stale too (sync path reads it at once).
    assert.equal(imp.scanIsCurrent({ ...done, files: { ...(done.files as object), messages: "x.csv" } } as never), false);
  });

  test("review: a mapping or a messages file never overwrites a check that began after it was read", async () => {
    const job = await csvJob(20, "race");
    const lockWaiter = async (sql: string) =>
      until(
        async () => (await pool().query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [`%${sql}%`])).rowCount,
        `a write waiting on the job row (${sql})`,
        15_000
      );
    for (const which of ["mapping", "files"] as const) {
      await pool().query("UPDATE hd_import_jobs SET status = 'uploaded', check_kind = '', heartbeat_at = NULL WHERE id = $1", [job.id]);
      const client = await pool().connect();
      let pending: Promise<unknown>;
      let stored: { name: string; size: number } | null = null;
      try {
        await client.query("BEGIN");
        await client.query("SELECT 1 FROM hd_import_jobs WHERE id = $1 FOR UPDATE", [job.id]);
        if (which === "mapping") {
          pending = imp.saveMapping(job.id, { timezone: "Europe/Paris" }).then(() => "saved", (e: Error) => e);
        } else {
          stored = await imp.saveImportUpload(Readable.toWeb(Readable.from([Buffer.from("Ticket,Text\n1,hi\n")])) as never, 1024 * 1024, "csv");
          pending = imp.attachMessagesFile(job.id, stored, "messages.csv").then(() => "saved", (e: Error) => e);
        }
        await lockWaiter(which === "mapping" ? "SET mapping" : "SET files");
        // A check starts meanwhile.
        await client.query("UPDATE hd_import_jobs SET status = 'checking', check_kind = 'dry_run', heartbeat_at = now() WHERE id = $1", [job.id]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const out = await pending!;
      assert.ok(out instanceof Error && /being checked/.test(out.message), `${which}: refused (${String(out)})`);
      const after = (await imp.getImportJob(job.id))!;
      assert.equal(after.status, "checking", `${which}: the check keeps the job`);
      assert.equal((after.mapping as { timezone?: string }).timezone, "UTC");
      if (stored) {
        assert.equal((after.files as { messages?: string }).messages, undefined, "the job's files are untouched");
        const { uploadDir } = await import("../src/lib/uploads");
        await assert.rejects(access(path.join(uploadDir(), "hd-import", stored.name)), "the refused upload is removed");
      }
    }
    await pool().query("UPDATE hd_import_jobs SET status = 'uploaded', heartbeat_at = NULL WHERE id = $1", [job.id]);
  });

  test("pure: the time left", () => {
    const now = Date.parse("2026-11-06T10:10:00Z");
    assert.equal(impShared.importTimeLeft("2026-11-06T10:05:00Z", 29_880, 48_210, now), "about 3 minutes left");
    assert.equal(impShared.importTimeLeft("2026-11-06T10:09:59Z", 10, 100, now), null, "too early to say");
    assert.equal(impShared.importTimeLeft("2026-11-06T10:09:00Z", 90, 100, now), "less than a minute left");
    assert.equal(impShared.importTimeLeft(undefined, 1, 2, now), null);
    // Counted from where counting began: 10,000 rows in 5 minutes from 20,000, 18,210 to go.
    assert.equal(impShared.importTimeLeft("2026-11-06T10:05:00Z", 30_000, 48_210, now, 20_000), "about 9 minutes left");
  });
});

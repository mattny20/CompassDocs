// Helpdesk 1.19.0 (agent O): contact cards. The pure link builders and
// settings sanitiser, then the cards themselves through the routes the desk
// and Get help call (route handlers called directly, next/headers and
// lib/ee stubbed as in test/helpdesk-core.test.ts).
//
// Parallel-safe: every user, directory person, directory field, team and
// ticket here is this file's own (a stamp in every name/key). Global state:
// the helpdesk_contact_cards setting and, for one test, the directory's
// contact-column visibility are changed under advisory locks and restored
// exactly as they were. Nobody is a workspace admin: the "directory admin"
// viewer is the same plain user passed to the library with role "admin".
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-contact-cards.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { hashPassword, newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import {
  cardInitials,
  localTimeIn,
  mailtoHref,
  sanitizeContactCardSettings,
  slackLinks,
  slackMemberId,
  teamsLinks,
  telHref,
  webexLinks,
  HD_REQUESTER_SEES_DEFAULT,
} from "../src/lib/helpdesk/contact-cards-shared";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-contacts.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-contacts.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["helpdesk"] as string[] };
{
  const jar = () => {
    const out = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return out;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return {
        get: (name: string) => (j.has(name) ? { name, value: j.get(name) } : undefined),
        getAll: () => [...j].map(([name, value]) => ({ name, value })),
        has: (name: string) => j.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => edition, eePresent: () => true, featureEnabled: async (f: string) => edition.features.includes(f) };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
    if (request === "../ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "..", "ee") === EE_REAL) return EE_STUB;
    return resolve.call(this, request, parent, ...rest);
  };
}

type AnyHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as AnyHandler)(req, { params: Promise.resolve(params) });
    const body = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}
function get(url: string, session: string): Request {
  return new Request(`http://localhost${url}`, { headers: { cookie: `compass_session=${session}`, "x-forwarded-for": "203.0.113.78" } });
}

// --- Pure rules ------------------------------------------------------------------

describe("contact card links (pure)", () => {
  test("tel: links keep a leading +, digits and an extension", () => {
    assert.equal(telHref("+44 161 234 5678 x204"), "tel:+441612345678;ext=204");
    assert.equal(telHref("(602) 555-0134 ext. 12"), "tel:6025550134;ext=12");
    assert.equal(telHref("555-0100"), "tel:5550100");
    assert.equal(telHref("ask reception"), "", "no digits, no link");
    assert.equal(telHref("javascript:alert(1)"), "", "a script is not a number");
  });

  test("mailto only for one address", () => {
    assert.equal(mailtoHref("ana@example.com"), "mailto:ana@example.com");
    assert.equal(mailtoHref("ana@example.com?bcc=evil@example.com"), "");
    assert.equal(mailtoHref("a b@example.com"), "");
  });

  test("Teams links escape the address and refuse anything that is not one", () => {
    const l = teamsLinks("ana+it@example.com")!;
    assert.equal(l.href, "https://teams.microsoft.com/l/chat/0/0?users=ana%2Bit%40example.com");
    assert.equal(l.app_href, "msteams:/l/chat/0/0?users=ana%2Bit%40example.com");
    assert.equal(teamsLinks("ana&users=boss@example.com")!.href, "https://teams.microsoft.com/l/chat/0/0?users=ana%26users%3Dboss%40example.com", "a second parameter cannot ride along");
    assert.equal(teamsLinks("<script>@example.com"), null);
    assert.equal(teamsLinks("ana@example.com\nbcc"), null);
    assert.equal(teamsLinks(""), null);
  });

  test("Webex: a room link on webex.com, an address (or sip:) for chat, nothing else", () => {
    assert.deepEqual(webexLinks("https://acme.webex.com/meet/ana"), { href: "https://acme.webex.com/meet/ana", label: "Webex room", value: "https://acme.webex.com/meet/ana" });
    assert.equal(webexLinks("sip:ana@acme.webex.com")!.href, "webexteams://im?email=ana%40acme.webex.com");
    assert.equal(webexLinks("ana@example.com")!.label, "Webex");
    assert.equal(webexLinks("https://evil.example.com/webex.com"), null, "only webex.com hosts");
    assert.equal(webexLinks("https://user:pw@acme.webex.com/x"), null, "no credentials in a link");
    assert.equal(webexLinks("javascript:alert(1)"), null);
  });

  test("Slack: member ID from a value, workspace domain normalised, app link with the team ID", () => {
    assert.equal(slackMemberId("U012AB3CD"), "U012AB3CD");
    assert.equal(slackMemberId("<@W0ABCDE12>"), "W0ABCDE12");
    assert.equal(slackMemberId("https://acme.slack.com/team/U012AB3CD"), "U012AB3CD");
    assert.equal(slackMemberId("u012ab3cd"), "", "IDs are upper-case");
    assert.equal(slackMemberId("U01\"><script>"), "");
    assert.deepEqual(slackLinks("U012AB3CD", "https://Acme.slack.com/", "T01ABCDEF"), {
      href: "https://acme.slack.com/team/U012AB3CD",
      app_href: "slack://user?team=T01ABCDEF&id=U012AB3CD",
      value: "U012AB3CD",
    });
    assert.deepEqual(slackLinks("U012AB3CD", "", "T01ABCDEF"), { href: "slack://user?team=T01ABCDEF&id=U012AB3CD", value: "U012AB3CD" });
    assert.equal(slackLinks("U012AB3CD", "evil.com/x?", ""), null, "a bad domain and no team: nowhere to open it");
    assert.equal(slackLinks("U012AB3CD", "acme", "not-a-team")!.app_href, undefined);
  });

  test("local time in a zone, with its offset", () => {
    const at = new Date("2026-07-01T12:05:00Z");
    assert.deepEqual(localTimeIn("Europe/London", at), { time: "13:05", offset: "GMT+1" });
    assert.equal(localTimeIn("America/Phoenix", at)!.time, "05:05");
    assert.equal(localTimeIn("Mars/Olympus", at), null);
    assert.equal(localTimeIn(null, at), null);
  });

  test("settings defaults and sanitising", () => {
    const d = sanitizeContactCardSettings(null);
    assert.equal(d.fields.desk_phone, "phone");
    assert.equal(d.fields.cell_phone, "mobile");
    assert.equal(d.teams.mode, "microsoft");
    assert.deepEqual(d.requester_sees, HD_REQUESTER_SEES_DEFAULT);
    assert.ok(!d.requester_sees.includes("desk_phone") && !d.requester_sees.includes("cell_phone"), "requesters: no phones by default");
    assert.ok(d.agent_sees.includes("cell_phone") && d.agent_sees.includes("extra"), "agents: everything");
    const s = sanitizeContactCardSettings({
      fields: { desk_phone: "x'; drop", cell_phone: "custom_cell" },
      teams: { mode: "sometimes" },
      slack: { mode: "field", field: "slack_id", domain: "ACME.slack.com", team_id: "t01abc" },
      extra: ["a", "a", "b", "c", "d", "e", "f", "g"],
      vip: { rule: "field", list: [{ kind: "user", user_id: 5, note: "  Board  member " }, { kind: "user", user_id: 5 }, { kind: "group", group_id: -1 }, { kind: "department", department: "Legal" }] },
      office_timezones: { Phoenix: "America/Phoenix", Mars: "Mars/Olympus" },
      requester_sees: ["photo", "cell_phone", "nonsense"],
    });
    assert.equal(s.fields.desk_phone, "", "a bad key is dropped");
    assert.equal(s.fields.cell_phone, "custom_cell");
    assert.equal(s.teams.mode, "microsoft");
    assert.equal(s.slack.domain, "acme");
    assert.equal(s.slack.team_id, "T01ABC");
    assert.deepEqual(s.extra, ["a", "b", "c", "d", "e", "f"], "six at most, no repeats");
    assert.deepEqual(s.vip.list, [{ kind: "user", user_id: 5, note: "Board member" }, { kind: "department", department: "Legal", note: "" }]);
    assert.deepEqual(s.office_timezones, { phoenix: "America/Phoenix" });
    assert.deepEqual(s.requester_sees, ["photo", "cell_phone"]);
    assert.equal(cardInitials("Ana María Ruiz"), "AR");
  });
});

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdcc-${Date.now()}-${randomBytes(3).toString("hex")}`;
const K = `hdcc${randomBytes(3).toString("hex")}`; // field keys: a-z0-9_
const CARDS_LOCK = 728460; // helpdesk_contact_cards
const COLUMNS_LOCK = 728461; // directory_column_visibility
const PEOPLE = ["requester", "agentA", "agentB", "colleague", "stranger", "hdAdmin"] as const;
type Who = (typeof PEOPLE)[number];
const P = {} as Record<Who, { id: number; session: string; email: string }>;
const person: Record<string, number> = {};
const fieldIds: number[] = [];
let teamA = 0;
let teamB = 0;
let groupId = 0;
let roleAdmin = 0;
let ticketNo = 0;
let ticketId = 0;
let emailTicketNo = 0;
let earlierNo = 0;
let lockClient: PoolClient | null = null;
let savedCards: string | undefined;

const viewer = (k: Who, role: "viewer" | "admin" = "viewer") => ({ id: P[k].id, role });
async function settings(patch: Record<string, unknown>) {
  const { saveContactCardSettings, defaultContactCardSettings } = await import("../src/lib/helpdesk/contact-cards");
  await pool().query("DELETE FROM settings WHERE key = 'helpdesk_contact_cards'");
  await saveContactCardSettings({ ...defaultContactCardSettings(), ...patch });
}
async function ticketRef(n: number) {
  const { getTicketByNumber } = await import("../src/lib/helpdesk/tickets");
  return (await getTicketByNumber(n))!;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [CARDS_LOCK]);
  savedCards = await getSetting("helpdesk_contact_cards");

  const creds = hashPassword("Helpdesk!Cards123");
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const k of PEOPLE) {
    const email = `${STAMP}-${k}@example.test`;
    const r = await fixtureQuery(
      `INSERT INTO users (username, name, email, role, status, password_hash, password_salt)
       VALUES ($1, $2, $3, 'viewer', 'active', $4, $5) RETURNING id`,
      [`${STAMP}-${k}`, `Cc ${k} ${STAMP}`, email, creds.hash, creds.salt]
    );
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    P[k] = { id: r.rows[0].id, session, email };
  }
  const agentRole = (await pool().query("SELECT id FROM roles WHERE key = 'helpdesk-agent'")).rows[0].id;
  for (const k of ["agentA", "agentB"] as const) {
    await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [agentRole, P[k].id]);
  }
  roleAdmin = (await fixtureQuery("INSERT INTO roles (key, name, description) VALUES ($1, $2, '') RETURNING id", [`${STAMP}-admin`, `${STAMP} configure`])).rows[0].id;
  await pool().query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.admin')", [roleAdmin]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [roleAdmin, P.hdAdmin.id]);
  teamA = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  teamB = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($3, $4, 'agent')", [teamA, P.agentA.id, teamB, P.agentB.id]);
  groupId = (await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} board`])).rows[0].id;
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, P.colleague.id]);

  // The directory: custom fields (one admins-only), the people, a manager link.
  const { createField, createPerson } = await import("../src/lib/directory");
  const field = async (key: string, label: string, visibility = "everyone", display: "field" | "phone" = "field") => {
    const f = await createField({ key: `${K}_${key}`, label: `${label} ${K}`, kind: "text", visibility, display });
    fieldIds.push(f.id);
    return f.key;
  };
  const F = {
    slack: await field("slack", "Slack ID"),
    webex: await field("webex", "Webex"),
    pronouns: await field("pronouns", "Pronouns"),
    secret: await field("secret", "Private cell", "admins", "phone"),
    tier: await field("tier", "Tier"),
    tz: await field("tz", "Time zone"),
    ext: await field("ext", "Extension", "everyone", "phone"),
  };
  (globalThis as any).__F = F;
  const boss = await createPerson({ name: `Sara Haddad ${STAMP}`, title: "IT Director", department: `${STAMP} IT`, email: `${STAMP}-boss@example.test` });
  person.boss = boss.id;
  const ana = await createPerson({
    name: `Ana Ruiz ${STAMP}`,
    title: "Paralegal",
    department: `${STAMP} Legal`,
    email: P.requester.email,
    phone: "+1 602 555 0134 x218",
    mobile: "+1 602 555 0199",
    office: `${STAMP} Phoenix`,
    custom: { [F.slack]: "U012AB3CD", [F.webex]: "https://acme.webex.com/meet/ana", [F.pronouns]: "she/her", [F.secret]: "+1 602 555 0777", [F.tier]: "Partner", [F.ext]: "218" },
    links: { manager: [boss.id] },
  });
  person.ana = ana.id;
  const ben = await createPerson({ name: `Ben Okafor ${STAMP}`, title: "Service desk analyst", department: `${STAMP} IT`, email: P.agentA.email, phone: "+44 161 496 0000", mobile: "+44 7700 900123", office: `${STAMP} Manchester`, custom: { [F.tz]: "Europe/London" } });
  person.ben = ben.id;
  await pool().query("UPDATE users SET directory_person_id = $1 WHERE id = $2", [ana.id, P.requester.id]);
  await pool().query("UPDATE users SET directory_person_id = $1 WHERE id = $2", [ben.id, P.agentA.id]);

  // A ticket in team A, assigned to agentA, who replied in public; a colleague named as a contact by writing in.
  const t = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open') RETURNING id, number`,
    [`${STAMP} VPN drops`, P.requester.id, `Cc requester ${STAMP}`, P.requester.email, teamA, P.agentA.id]
  );
  ticketId = t.rows[0].id;
  ticketNo = t.rows[0].number;
  await pool().query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via) VALUES
       ($1, $2, 'requester', $3, 'public', 'It drops every hour.', 'portal'),
       ($1, $4, 'agent', $5, 'public', 'Looking now.', 'desk'),
       ($1, $6, 'colleague', $7, 'public', 'Same for me.', 'email')`,
    [ticketId, P.requester.id, P.requester.email, P.agentA.id, P.agentA.email, P.colleague.id, P.colleague.email]
  );
  const early = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, created_at)
     VALUES ($1, $2, 'r', $3, $4, 'solved', now() - interval '10 days') RETURNING number`,
    [`${STAMP} Earlier`, P.requester.id, P.requester.email, teamA]
  );
  earlierNo = early.rows[0].number;
  await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status) VALUES ($1, $2, 'r', $3, $4, 'open')`,
    [`${STAMP} Hidden from A`, P.requester.id, P.requester.email, teamB]
  );
  const et = await fixtureQuery(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source)
     VALUES ($1, NULL, 'Olu Outsider', $2, $3, 'new', 'email') RETURNING number`,
    [`${STAMP} From outside`, `${STAMP}-outsider@example.test`, teamA]
  );
  emailTicketNo = et.rows[0].number;
});

after(async () => {
  const ids = PEOPLE.map((k) => P[k]?.id).filter(Boolean);
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2)", [[teamA, teamB], ids]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamA, teamB]]);
  await pool().query("DELETE FROM hd_agent_prefs WHERE user_id = ANY($1)", [ids]);
  await pool().query("UPDATE users SET directory_person_id = NULL WHERE id = ANY($1)", [ids]);
  await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [Object.values(person)]);
  await pool().query("DELETE FROM directory_fields WHERE id = ANY($1)", [fieldIds]);
  await pool().query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM roles WHERE id = $1", [roleAdmin]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  if (savedCards === undefined) await pool().query("DELETE FROM settings WHERE key = 'helpdesk_contact_cards'");
  else await setSetting("helpdesk_contact_cards", savedCards);
  if (lockClient) {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [CARDS_LOCK]).catch(() => {});
    lockClient.release();
  }
});

const routes = {
  list: () => import("../src/app/api/helpdesk/contacts/route"),
  one: () => import("../src/app/api/helpdesk/contacts/[userId]/route"),
  admin: () => import("../src/app/api/helpdesk/admin/contact-cards/route"),
};

describe("contact cards (integration)", () => {
  test("defaults: an agent sees the requester's directory card, everything mapped", async () => {
    await settings({});
    const { contactCardFor } = await import("../src/lib/helpdesk/contact-cards");
    const card = await contactCardFor(viewer("agentA"), P.requester.id, { ticket: await ticketRef(ticketNo), audience: "agent" });
    assert.equal(card.directory_id, person.ana);
    assert.equal(card.name, `Cc requester ${STAMP}`, "the account's name");
    assert.equal(card.title, "Paralegal");
    assert.equal(card.department, `${STAMP} Legal`);
    assert.equal(card.office?.name, `${STAMP} Phoenix`);
    assert.equal(card.office?.local_time, null, "no time zone known yet");
    assert.deepEqual(card.manager, { name: `Sara Haddad ${STAMP}`, directory_id: person.boss });
    assert.deepEqual(
      card.phones.map((p) => [p.kind, p.value, p.tel_href]),
      [["desk", "+1 602 555 0134 x218", "tel:+16025550134;ext=218"], ["cell", "+1 602 555 0199", "tel:+16025550199"]]
    );
    assert.equal(card.email, P.requester.email);
    assert.deepEqual(card.im, [], "Teams defaults to Microsoft-synced people; Webex and Slack are off");
    assert.equal(card.profile_url, `/directory/${person.ana}`);
    assert.equal(card.vcard_url, `/api/directory/${person.ana}/vcard`);
    assert.match(card.qr, /^data:image\/png;base64,/);
    assert.equal(card.earlier_tickets?.count, 1, "the team-B ticket is not agent A's to count");
    assert.equal(card.earlier_tickets?.recent[0].number, earlierNo);
    assert.equal(card.vip.vip, false);
    assert.equal(card.minimal, false);
  });

  test("custom fields mapped to Webex, Slack, pronouns and extras; Teams for everyone", async () => {
    const F = (globalThis as any).__F;
    await settings({
      fields: { ...(await import("../src/lib/helpdesk/contact-cards")).HD_CARD_FIELDS_DEFAULT, pronouns: F.pronouns },
      teams: { mode: "everyone", field: "" },
      webex: { mode: "field", field: F.webex },
      slack: { mode: "field", field: F.slack, domain: "acme", team_id: "T01ABCDEF" },
      extra: [F.tier, F.ext],
    });
    const { contactCardFor } = await import("../src/lib/helpdesk/contact-cards");
    const card = await contactCardFor(viewer("agentA"), P.requester.id, { ticket: await ticketRef(ticketNo), audience: "agent" });
    assert.equal(card.pronouns, "she/her");
    assert.deepEqual(
      card.im.map((m) => [m.kind, m.href, m.app_href ?? null]),
      [
        ["teams", `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(P.requester.email)}`, `msteams:/l/chat/0/0?users=${encodeURIComponent(P.requester.email)}`],
        ["webex", "https://acme.webex.com/meet/ana", null],
        ["slack", "https://acme.slack.com/team/U012AB3CD", "slack://user?team=T01ABCDEF&id=U012AB3CD"],
      ]
    );
    assert.deepEqual(card.extra.map((x) => x.value), ["Partner"], "a text extra");
    assert.ok(card.phones.some((p) => p.kind === "other" && p.value === "218" && p.label.startsWith("Extension")), "a phone-display extra joins the phones");
    // Teams for Microsoft-synced people only: a synced entry gets it, a manual one does not.
    await settings({ teams: { mode: "microsoft", field: "" } });
    await pool().query("UPDATE directory_people SET source = 'graph', external_id = $2 WHERE id = $1", [person.ana, `${STAMP}-ext`]);
    try {
      const synced = await contactCardFor(viewer("agentA"), P.requester.id, { ticket: await ticketRef(ticketNo), audience: "agent" });
      assert.deepEqual(synced.im.map((m) => m.kind), ["teams"]);
      assert.match(synced.calendar_href ?? "", /^https:\/\/outlook\.office\.com\/calendar\/deeplink\/compose\?to=/);
    } finally {
      await pool().query("UPDATE directory_people SET source = 'manual', external_id = NULL WHERE id = $1", [person.ana]);
    }
  });

  test("directory visibility wins: an admins-only field mapped to Cell is blank for non-admin viewers", async () => {
    const F = (globalThis as any).__F;
    const { HD_CARD_FIELDS_DEFAULT, HD_CARD_PARTS, contactCardFor } = await import("../src/lib/helpdesk/contact-cards");
    await settings({ fields: { ...HD_CARD_FIELDS_DEFAULT, cell_phone: F.secret }, extra: [F.secret], requester_sees: [...HD_CARD_PARTS] });
    const t = await ticketRef(ticketNo);
    const agentView = await contactCardFor(viewer("agentA"), P.requester.id, { ticket: t, audience: "agent" });
    assert.ok(!agentView.phones.some((p) => p.value.includes("0777")), "an agent who is not a directory admin never gets it");
    assert.ok(!JSON.stringify(agentView).includes("0777"), "not anywhere in the card");
    const adminView = await contactCardFor(viewer("agentA", "admin"), P.requester.id, { ticket: t, audience: "agent" });
    assert.ok(adminView.phones.some((p) => p.kind === "cell" && p.value === "+1 602 555 0777"), "a directory admin does");
    // The requester reading their agent's card: the same rule (the agent has no value, so check the field never appears).
    const reqView = await contactCardFor(viewer("requester"), P.agentA.id, { ticket: t, audience: "requester" });
    assert.ok(!JSON.stringify(reqView).includes(F.secret));
  });

  test("directory visibility wins: the built-in mobile column set to admins only", async () => {
    const client = await pool().connect();
    await client.query("SELECT pg_advisory_lock($1)", [COLUMNS_LOCK]);
    const saved = await getSetting("directory_column_visibility");
    try {
      await settings({});
      await setSetting("directory_column_visibility", JSON.stringify({ mobile: "admins" }));
      const { contactCardFor } = await import("../src/lib/helpdesk/contact-cards");
      const t = await ticketRef(ticketNo);
      const agent = await contactCardFor(viewer("agentA"), P.requester.id, { ticket: t, audience: "agent" });
      assert.deepEqual(agent.phones.map((p) => p.kind), ["desk"], "no cell for a non-admin agent");
      const admin = await contactCardFor(viewer("agentA", "admin"), P.requester.id, { ticket: t, audience: "agent" });
      assert.deepEqual(admin.phones.map((p) => p.kind), ["desk", "cell"]);
    } finally {
      if (saved === undefined) await pool().query("DELETE FROM settings WHERE key = 'directory_column_visibility'");
      else await setSetting("directory_column_visibility", saved);
      await client.query("SELECT pg_advisory_unlock($1)", [COLUMNS_LOCK]).catch(() => {});
      client.release();
    }
  });

  test("a requester sees only the agent working their request, with requester fields", async () => {
    await settings({});
    const { list, one } = { list: await routes.list(), one: await routes.one() };
    const r = await call(list.GET, get(`/api/helpdesk/contacts?ticket=${ticketNo}`, P.requester.session));
    assert.equal(r.status, 200);
    assert.equal(r.body.audience, "requester");
    assert.deepEqual(r.body.contacts.map((c: any) => c.user_id), [P.agentA.id], "the assignee only: not the colleague who wrote in");
    const card = r.body.contacts[0];
    assert.equal(card.title, "Service desk analyst");
    assert.deepEqual(card.phones, [], "phones are off for requesters by default");
    assert.equal(card.vip.vip, false);
    assert.equal(card.earlier_tickets, null);
    assert.deepEqual(card.team.names, [`${STAMP} IT`]);
    assert.equal(card.team.role_label, "Agent");
    assert.equal(card.availability, "available");
    assert.equal(card.office.name, `${STAMP} Manchester`);
    assert.equal(card.office.local_time, null, "no time zone known for Manchester yet");
  });

  test("requester: nobody else's card, and nothing on someone else's ticket", async () => {
    await settings({});
    const one = await routes.one();
    const list = await routes.list();
    assert.equal((await call(one.GET, get(`/api/helpdesk/contacts/${P.agentA.id}?ticket=${ticketNo}`, P.requester.session), { userId: String(P.agentA.id) })).status, 200);
    for (const k of ["agentB", "colleague", "requester"] as const) {
      const r = await call(one.GET, get(`/api/helpdesk/contacts/${P[k].id}?ticket=${ticketNo}`, P.requester.session), { userId: String(P[k].id) });
      assert.equal(r.status, 404, `${k}: not theirs to see`);
    }
    assert.equal((await call(list.GET, get(`/api/helpdesk/contacts?ticket=${ticketNo}`, P.stranger.session))).status, 404, "a stranger");
    assert.equal((await call(list.GET, get(`/api/helpdesk/contacts?ticket=${ticketNo}`, P.colleague.session))).status, 404, "a contact is not the requester");
  });

  test("an agent gets cards only for tickets they can see, and only for people on them", async () => {
    await settings({});
    const one = await routes.one();
    const list = await routes.list();
    const b = await call(list.GET, get(`/api/helpdesk/contacts?ticket=${ticketNo}`, P.agentB.session));
    assert.equal(b.status, 404, "agent B (team HR) cannot see team IT's ticket");
    const bOne = await call(one.GET, get(`/api/helpdesk/contacts/${P.requester.id}?ticket=${ticketNo}`, P.agentB.session), { userId: String(P.requester.id) });
    assert.equal(bOne.status, 404);
    const a = await call(list.GET, get(`/api/helpdesk/contacts?ticket=${ticketNo}`, P.agentA.session));
    assert.equal(a.status, 200);
    assert.equal(a.body.audience, "agent");
    assert.deepEqual(a.body.contacts.map((c: any) => [c.user_id, c.relation]), [[P.requester.id, "requester"], [P.colleague.id, "contact"]]);
    const stranger = await call(one.GET, get(`/api/helpdesk/contacts/${P.stranger.id}?ticket=${ticketNo}`, P.agentA.session), { userId: String(P.stranger.id) });
    assert.equal(stranger.status, 404, "someone not on the ticket");
    const colleague = await call(one.GET, get(`/api/helpdesk/contacts/${P.colleague.id}?ticket=${ticketNo}`, P.agentA.session), { userId: String(P.colleague.id) });
    assert.equal(colleague.status, 200);
    assert.equal(colleague.body.card.minimal, true, "no directory entry: a minimal card");
    assert.equal(colleague.body.card.email, P.colleague.email);
    edition.features = [];
    try {
      assert.equal((await call(list.GET, get(`/api/helpdesk/contacts?ticket=${ticketNo}`, P.agentA.session))).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("someone with no account: a minimal card by email", async () => {
    await settings({});
    const one = await routes.one();
    const r = await call(one.GET, get(`/api/helpdesk/contacts/0?ticket=${emailTicketNo}&email=${encodeURIComponent(`${STAMP}-outsider@example.test`)}`, P.agentA.session), { userId: "0" });
    assert.equal(r.status, 200);
    assert.equal(r.body.card.name, "Olu Outsider");
    assert.equal(r.body.card.email, `${STAMP}-outsider@example.test`);
    assert.equal(r.body.card.minimal, true);
    assert.equal(r.body.card.directory_id, null);
    assert.deepEqual(r.body.card.phones, []);
    const other = await call(one.GET, get(`/api/helpdesk/contacts/0?ticket=${emailTicketNo}&email=someone-else@example.test`, P.agentA.session), { userId: "0" });
    assert.equal(other.status, 404);
  });

  test("VIP: a directory rule, the helpdesk list (person, group, department), never on a requester's view", async () => {
    const F = (globalThis as any).__F;
    const cc = await import("../src/lib/helpdesk/contact-cards");
    await settings({});
    assert.deepEqual(await cc.vipInfo(P.requester.id), { vip: false, reason: "" }, "off by default");
    await settings({ vip: { rule: "field", field: F.tier, value: "partner", marker_id: "", list: [] } });
    const v = await cc.vipInfo(P.requester.id);
    assert.equal(v.vip, true);
    assert.match(v.reason, /^Directory: Tier .* is partner$/);
    assert.equal(await cc.isVip(P.agentA.id), false);
    await settings({
      vip: {
        rule: "off", field: "", value: "", marker_id: "",
        list: [
          { kind: "user", user_id: P.agentB.id, note: "Board member" },
          { kind: "group", group_id: groupId, note: "" },
          { kind: "department", department: `${STAMP} legal`, note: "" },
        ],
      },
    });
    assert.deepEqual(await cc.vipInfo(P.agentB.id), { vip: true, reason: "VIP list: Board member" });
    assert.deepEqual(await cc.vipInfo(P.colleague.id), { vip: true, reason: `VIP list: ${STAMP} board` });
    assert.deepEqual(await cc.vipInfo(P.requester.id), { vip: true, reason: `VIP list: ${STAMP} Legal` }, "department, case-insensitively");
    const map = await cc.vipMap([P.agentB.id, P.colleague.id, P.requester.id, P.stranger.id, null]);
    assert.deepEqual([...map].map(([id, x]) => [id, x.vip]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [P.requester.id, true], [P.agentB.id, true], [P.colleague.id, true], [P.stranger.id, false],
    ].sort((a, b) => Number(a[0]) - Number(b[0])));
    const card = await cc.contactCardFor(viewer("agentA"), P.requester.id, { ticket: await ticketRef(ticketNo), audience: "agent" });
    assert.equal(card.vip.vip, true, "the agent's card carries it");
    // An admins-only field as the rule: VIP, but the reason does not repeat the value.
    await settings({ vip: { rule: "field", field: F.secret, value: "", marker_id: "", list: [] } });
    assert.deepEqual(await cc.vipInfo(P.requester.id), { vip: true, reason: "Directory VIP rule" });
    // The requester's own view of their agent never says VIP.
    await settings({ vip: { rule: "off", field: "", value: "", marker_id: "", list: [{ kind: "user", user_id: P.agentA.id, note: "x" }] } });
    const req = await cc.contactCardFor(viewer("requester"), P.agentA.id, { ticket: await ticketRef(ticketNo), audience: "requester" });
    assert.deepEqual(req.vip, { vip: false, reason: "" });
  });

  test("office local time: from the office's time zone, or a person field", async () => {
    const F = (globalThis as any).__F;
    const { contactCardFor, HD_CARD_FIELDS_DEFAULT } = await import("../src/lib/helpdesk/contact-cards");
    await settings({ office_timezones: { [`${STAMP} Phoenix`.toLowerCase()]: "America/Phoenix" } });
    const t = await ticketRef(ticketNo);
    const c = await contactCardFor(viewer("agentA"), P.requester.id, { ticket: t, audience: "agent" });
    assert.equal(c.office?.timezone, "America/Phoenix");
    assert.equal(c.office?.local_time, localTimeIn("America/Phoenix")!.time);
    assert.equal(c.office?.utc_offset, "GMT-7");
    await settings({ fields: { ...HD_CARD_FIELDS_DEFAULT, timezone: F.tz } });
    const b = await contactCardFor(viewer("requester"), P.agentA.id, { ticket: t, audience: "requester" });
    assert.equal(b.office?.name, `${STAMP} Manchester`);
    assert.equal(b.office?.timezone, "Europe/London");
    await settings({ requester_sees: ["photo", "title", "office"] });
    const noTime = await contactCardFor(viewer("requester"), P.agentA.id, { ticket: t, audience: "requester" });
    assert.equal(noTime.office?.local_time, null, "local time off for requesters");
    assert.equal(noTime.email, "", "email off too");
  });
  test("the settings route: settings.manage only, sanitised, audited", async () => {
    await settings({});
    const admin = await routes.admin();
    const put = (session: string, body: unknown) =>
      new Request("http://localhost/api/helpdesk/admin/contact-cards", {
        method: "PUT",
        headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.78" },
        body: JSON.stringify(body),
      });
    assert.equal((await call(admin.GET, get("/api/helpdesk/admin/contact-cards", P.agentA.session))).status, 403, "an agent cannot configure");
    assert.equal((await call(admin.PUT, put(P.agentA.session, { extra: [] }))).status, 403);
    const g = await call(admin.GET, get("/api/helpdesk/admin/contact-cards", P.hdAdmin.session));
    assert.equal(g.status, 200);
    assert.ok(g.body.options.fields.some((f: any) => f.key === "mobile" && f.builtin));
    assert.ok(g.body.options.fields.some((f: any) => f.key === (globalThis as any).__F.secret && f.visibility === "admins"));
    assert.ok(g.body.options.offices.some((o: any) => o.key === `${STAMP} phoenix`));
    const r = await call(admin.PUT, put(P.hdAdmin.session, { slack: { mode: "field", field: "x", domain: "https://Acme.slack.com", team_id: "" }, requester_sees: ["photo"] }));
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.slack.domain, "acme");
    assert.deepEqual(r.body.settings.requester_sees, ["photo"]);
    assert.equal(r.body.settings.fields.desk_phone, "phone", "keys not sent keep their values");
    const a = await pool().query("SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.settings.updated' ORDER BY id DESC LIMIT 1", [P.hdAdmin.id]);
    assert.equal(a.rows[0]?.details?.section, "contact_cards");
    assert.deepEqual(a.rows[0]?.details?.changed?.sort(), ["requester_sees", "slack"]);
  });
});

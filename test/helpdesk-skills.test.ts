// Helpdesk 1.19.2 skills and languages routing (agent W2): the language
// catalogue and parsing, the first-message detector (seven languages,
// quoted threads, too-short text), the rule action's checks and matching,
// the "Ticket language" condition; then against Postgres: the ticket's
// language from the directory or the first message, an agent setting it
// (timeline line, audit), skills and languages and agents' tags (gates,
// leads only for their teams, in-use refusals), and the engine: an agent
// with the right language and skills gets the ticket in turn, respecting
// availability, pauses, caps and team membership like round robin; nobody
// matching falls back to the team's turn or waits in the queue (and the
// sweep retries the skills decision); "Test a ticket" explains it; the
// "N agents match today" preview.
//
// Route handlers are called directly with real sessions: next/headers
// resolves to a stub serving the request under test and lib/ee to a stub
// that grants "helpdesk".
//
// Parallel-safe: every team, account, skill and ticket is this file's own
// (STAMP); each assignment rule is scoped to this file's team and to subjects
// carrying the STAMP. Languages are a workspace list keyed by code: the file
// removes only the ones it added. The directory field it needs exists only
// for the few statements that read it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-skills.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-skills.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-skills.virtual.js");
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
const skills = require("../src/lib/helpdesk/skills/shared") as typeof import("../src/lib/helpdesk/skills/shared");
const detect = require("../src/lib/helpdesk/skills/detect") as typeof import("../src/lib/helpdesk/skills/detect");
const skillStore = require("../src/lib/helpdesk/skills/store") as typeof import("../src/lib/helpdesk/skills/store");
const skillRoutes = require("../src/lib/helpdesk/skills/routes") as typeof import("../src/lib/helpdesk/skills/routes");
const shared = require("../src/lib/helpdesk/assignment/shared") as typeof import("../src/lib/helpdesk/assignment/shared");
const engine = require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine");
const store = require("../src/lib/helpdesk/assignment/store") as typeof import("../src/lib/helpdesk/assignment/store");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
const events = require("../src/lib/helpdesk/events") as typeof import("../src/lib/helpdesk/events");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const push = require("../src/lib/helpdesk/push") as typeof import("../src/lib/helpdesk/push");
const skillsRoute = require("../src/app/api/helpdesk/admin/skills/route") as typeof import("../src/app/api/helpdesk/admin/skills/route");
const skillRoute = require("../src/app/api/helpdesk/admin/skills/[id]/route") as typeof import("../src/app/api/helpdesk/admin/skills/[id]/route");
const languagesRoute = require("../src/app/api/helpdesk/admin/skills/languages/route") as typeof import("../src/app/api/helpdesk/admin/skills/languages/route");
const languageRoute = require("../src/app/api/helpdesk/admin/skills/languages/[code]/route") as typeof import("../src/app/api/helpdesk/admin/skills/languages/[code]/route");
const agentRoute = require("../src/app/api/helpdesk/admin/skills/agents/[userId]/route") as typeof import("../src/app/api/helpdesk/admin/skills/agents/[userId]/route");
const previewRoute = require("../src/app/api/helpdesk/admin/assignment/skills-preview/route") as typeof import("../src/app/api/helpdesk/admin/assignment/skills-preview/route");
const rulesRoute = require("../src/app/api/helpdesk/admin/assignment/rules/route") as typeof import("../src/app/api/helpdesk/admin/assignment/rules/route");
const testRoute = require("../src/app/api/helpdesk/admin/assignment/rules/test/route") as typeof import("../src/app/api/helpdesk/admin/assignment/rules/test/route");
const ticketLanguageRoute = require("../src/app/api/helpdesk/tickets/[number]/language/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/language/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdAssignFacts, HdAssignmentRule } from "../src/lib/helpdesk/assignment/shared";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

const URL_BASE = "http://localhost/api/helpdesk";
function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`${URL_BASE}${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdskills-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const teamIds: number[] = [];
const calendarIds: number[] = [];
const ruleIds: number[] = [];
const skillIds: number[] = [];
const addedLanguages: string[] = [];
const T: Record<string, number> = {};
const S: Record<string, number> = {};
let openCalendar = 0;

async function person(key: string, name: string, deskRole: string | null): Promise<Person> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session, name };
  return P[key];
}

async function team(key: string): Promise<number> {
  const r = await fixtureQuery("INSERT INTO hd_teams (name, position, calendar_id) VALUES ($1, 9200, $2) RETURNING id", [`${STAMP} ${key}`, openCalendar]);
  T[key] = r.rows[0].id;
  teamIds.push(T[key]);
  return T[key];
}

async function member(teamKey: string, personKey: string, role: "agent" | "lead" = "agent") {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [T[teamKey], P[personKey].id, role]);
}

async function settings(teamKey: string, patch: Record<string, unknown>) {
  const cur = await store.getTeamAssignment(T[teamKey]);
  const v = shared.validateTeamAssignment(patch, cur);
  assert.ok(v.ok, v.ok ? "" : v.error);
  await store.saveTeamAssignment(v.value, null);
}

async function availability(personKey: string, status: string) {
  await pool().query(
    `INSERT INTO hd_agent_prefs (user_id, availability, updated_at) VALUES ($1, $2, now() - interval '30 minutes')
     ON CONFLICT (user_id) DO UPDATE SET availability = EXCLUDED.availability, updated_at = EXCLUDED.updated_at`,
    [P[personKey].id, status]
  );
}

async function skill(key: string): Promise<number> {
  const s = await skillStore.createSkill(`${key} ${STAMP}`, null);
  S[key] = s.id;
  skillIds.push(s.id);
  return s.id;
}

async function language(code: string) {
  if (await skillStore.addLanguage(code, null)) addedLanguages.push(code);
}

async function tag(personKey: string, skillKeys: string[], languages: string[]) {
  await skillStore.setAgentTags(P[personKey].id, { skill_ids: skillKeys.map((k) => S[k]), languages });
}

let seq = 0;
/** A ticket with a first public message, as the core writes one (no hooks). */
async function ticket(o: { team: string | null; subject?: string; body?: string; requester?: string; assignee?: string }): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, assignee_id, status, priority, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'new', 'normal', 'portal') RETURNING id, number`,
    [
      `${o.subject ?? "Ticket"} ${STAMP} #${++seq}`,
      o.requester ? P[o.requester].id : null,
      o.requester ? P[o.requester].name : "Someone",
      o.requester ? `${STAMP}-${o.requester}@example.test` : `${STAMP}-anon${seq}@example.test`,
      o.team ? T[o.team] : null,
      o.assignee ? P[o.assignee].id : null,
    ]
  );
  if (o.body) {
    await pool().query(`INSERT INTO hd_messages (ticket_id, author_name, kind, body, via) VALUES ($1, 'Requester', 'public', $2, 'portal')`, [r.rows[0].id, o.body]);
  }
  return r.rows[0];
}

const assigneeOf = async (id: number) => (await pool().query("SELECT assignee_id FROM hd_tickets WHERE id = $1", [id])).rows[0].assignee_id as number | null;
const languageOf = async (id: number) =>
  (await pool().query<{ language: string | null; language_source: string }>("SELECT language, language_source FROM hd_tickets WHERE id = $1", [id])).rows[0];
const notesOf = async (id: number) =>
  (await pool().query<{ body: string }>("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' ORDER BY id", [id])).rows.map((r) => r.body);
const logOf = async (id: number) =>
  (await pool().query<{ method: string; to_user_id: number | null }>("SELECT method, to_user_id FROM hd_assignment_log WHERE ticket_id = $1 ORDER BY id", [id])).rows;

async function rule(input: Record<string, unknown>): Promise<HdAssignmentRule> {
  const v = shared.validateRuleInput(input);
  assert.ok(v.ok, v.ok ? "" : v.error);
  const r = await store.createRule(v.value as import("../src/lib/helpdesk/assignment/shared").HdAssignRuleInput, null);
  ruleIds.push(r.id);
  // Rules are global: run this file's ahead of anyone else's so another file's rule can't stop the run first.
  await pool().query("UPDATE hd_assignment_rules SET position = -200000 + id WHERE id = $1", [r.id]);
  return (await store.getRule(r.id))!;
}
async function dropRules() {
  await pool().query("DELETE FROM hd_assignment_rules WHERE id = ANY($1)", [ruleIds]);
  ruleIds.length = 0;
}
const stampCond = { field: "subject", op: "contains", value: [STAMP] };
const frenchCond = { field: "language", op: "equals", value: ["fr"] };

const FR = "Bonjour, je n'arrive plus à me connecter au VPN depuis ce matin. Pouvez-vous m'aider ? Merci";
const EN = "Hi, I can't connect to the VPN since this morning. Could you please help me? Thanks";

const ALL_DAY = Array.from({ length: 7 }, () => [{ start: "00:00", end: "24:00" }]);

before(async () => {
  await getSetting("__schema_bootstrap__");
  await store.assignmentReady();
  const c = await pool().query("INSERT INTO hd_calendars (name, timezone, schedule) VALUES ($1, 'UTC', $2) RETURNING id", [`${STAMP} open`, JSON.stringify(ALL_DAY)]);
  openCalendar = c.rows[0].id;
  calendarIds.push(openCalendar);
  for (const [k, n, r] of [
    ["ana", "Ana Kowalski", "agent"],
    ["sam", "Sam Lee", "agent"],
    ["marie", "Marie Bernard", "agent"],
    ["jonas", "Jonas Müller", "agent"],
    ["lead", "Lee Lead", "team_lead"],
    ["mgr", "Max Manager", "manager"],
    ["plain", "Pat Agent", "agent"],
    ["req", "Rae Requester", null],
  ] as const) {
    await person(k, n, r);
  }
  await team("desk");
  await team("people");
  for (const k of ["ana", "sam", "marie"]) await member("desk", k);
  await member("desk", "lead", "lead");
  await member("people", "jonas");
  for (const k of ["ana", "sam", "marie", "jonas", "lead"]) await availability(k, "available");
  await settings("desk", { mode: "round_robin", include_roles: ["agent"] });
  await settings("people", { mode: "round_robin" });
  await skill("Mac");
  await skill("Windows");
  await skill("Payroll");
  for (const code of ["en", "fr", "de"]) await language(code);
  await tag("ana", ["Mac"], ["en", "fr"]);
  await tag("sam", ["Windows"], ["en"]);
  await tag("marie", ["Windows"], ["fr", "en"]);
  await tag("jonas", ["Payroll"], ["de", "en"]);
  calendars.invalidateCalendarCache();
  email.setHelpdeskTransportForTests(async () => {});
  push.setPushTransportForTests(async () => ({ status: 201, headers: {} }) as never);
  notify.setAgentDeliverySpyForTests(() => {});
});

after(async () => {
  email.setHelpdeskTransportForTests(null);
  push.setPushTransportForTests(null);
  notify.setAgentDeliverySpyForTests(null);
  await pool().query("DELETE FROM hd_assignment_rules WHERE id = ANY($1)", [ruleIds]);
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR subject LIKE $3", [teamIds, userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teamIds]);
  await pool().query("DELETE FROM hd_calendars WHERE id = ANY($1)", [calendarIds]);
  await pool().query("DELETE FROM hd_skills WHERE id = ANY($1) OR name LIKE $2", [skillIds, `%${STAMP}%`]);
  // Only the languages this file added, and only while no other agent is tagged with them.
  for (const code of addedLanguages) {
    await pool().query("DELETE FROM hd_languages l WHERE l.code = $1 AND NOT EXISTS (SELECT 1 FROM hd_agent_languages a WHERE a.code = l.code AND a.user_id <> ALL($2::int[]))", [code, userIds]);
  }
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  calendars.invalidateCalendarCache();
  await pool().end();
});

// --- Pure ------------------------------------------------------------------------------

describe("languages (pure)", () => {
  test("normalizeLanguage reads tags, names and native names", () => {
    const n = skills.normalizeLanguage;
    assert.equal(n("fr"), "fr");
    assert.equal(n("fr-CA"), "fr");
    assert.equal(n("pt_BR"), "pt");
    assert.equal(n("EN-gb"), "en");
    assert.equal(n("French"), "fr");
    assert.equal(n("Français"), "fr");
    assert.equal(n("Deutsch"), "de");
    assert.equal(n("español"), "es");
    assert.equal(n("Nederlands"), "nl");
    assert.equal(n("French (Canada)"), "fr");
    assert.equal(n("nb-NO"), "no");
    assert.equal(n("deu"), "de");
    assert.equal(n("Klingon"), null);
    assert.equal(n(""), null);
    assert.equal(n(42), null);
  });

  test("languageName and the catalogue", () => {
    assert.equal(skills.languageName("de"), "German");
    assert.equal(skills.languageName(null), "");
    assert.ok(skills.isLanguageCode("nl"));
    assert.ok(!skills.isLanguageCode("xx"));
    for (const c of skills.HD_DETECTABLE_LANGUAGES) assert.ok(skills.isLanguageCode(c), c);
    const opts = skills.languageOptions(["fr", "en", "zz"]);
    assert.deepEqual(opts, [
      { value: "en", label: "English" },
      { value: "fr", label: "French" },
    ]);
  });
});

describe("detector (pure)", () => {
  const cases: [string, string][] = [
    ["en", "Hi, my laptop won't connect to the VPN since this morning. Can you help please?"],
    ["en", "I can't log in to my email, it says the password is wrong."],
    ["fr", "Bonjour, mon ordinateur ne se connecte plus au VPN depuis ce matin. Pouvez-vous m'aider ?"],
    ["fr", "Merci de réinitialiser mon mot de passe, il a expiré."],
    ["de", "Hallo, mein Laptop verbindet sich seit heute Morgen nicht mehr mit dem VPN. Können Sie mir bitte helfen?"],
    ["de", "Ich kann mich nicht bei meiner E-Mail anmelden, das Passwort ist angeblich falsch."],
    ["es", "Hola, mi portátil no se conecta a la VPN desde esta mañana. ¿Me pueden ayudar por favor?"],
    ["es", "No puedo entrar en mi correo, me dice que la contraseña es incorrecta."],
    ["it", "Buongiorno, il mio portatile non si collega alla VPN da stamattina. Potete aiutarmi per favore?"],
    ["it", "Non riesco ad accedere alla posta, dice che la password è sbagliata."],
    ["pt", "Olá, o meu portátil não liga à VPN desde esta manhã. Podem ajudar por favor? Obrigado"],
    ["pt", "Não consigo acessar o meu e-mail, diz que a senha está errada."],
    ["nl", "Hallo, mijn laptop maakt sinds vanochtend geen verbinding meer met de VPN. Kunnen jullie mij helpen?"],
    ["nl", "Ik kan niet inloggen op mijn mail, het wachtwoord is fout volgens het systeem."],
  ];
  for (const [want, text] of cases) {
    test(`${want}: ${text.slice(0, 40)}…`, () => {
      assert.equal(detect.detectLanguage(text)?.code ?? null, want);
    });
  }

  test("too short, or nothing it knows: null, never a guess", () => {
    assert.equal(detect.detectLanguage("VPN down"), null);
    assert.equal(detect.detectLanguage(""), null);
    assert.equal(detect.detectLanguage(null), null);
    assert.equal(detect.detectLanguage("Server01 CPU 99% disk /var 100% load 12.5"), null);
  });

  test("the quoted thread under a reply and HTML are ignored", () => {
    const reply = `<p>Bonjour,</p><p>Je n'ai plus accès à Teams depuis hier.</p>\nOn Mon, 3 Nov 2026, Sam wrote:\n> Hi, can you please check the thing that is broken and tell me when it is fixed? Thanks a lot, we are all waiting for this and it is not working`;
    assert.equal(detect.detectLanguage(reply)?.code, "fr");
    const quoted = "Danke!\n> Hello, could you please tell me when the printer on the second floor will be working again? Thanks";
    assert.notEqual(detect.detectLanguage(quoted)?.code, "en");
    assert.equal(detect.ownText("Hi <b>there</b> see https://example.com/x or mail a@b.co\n> quoted").includes("example"), false);
  });
});

describe("criteria (pure)", () => {
  test("validateSkillCriteria", () => {
    assert.deepEqual(skills.validateSkillCriteria({ language: "fr", skill_ids: [3, "4", 3] }), { ok: true, value: { language: "fr", skill_ids: [3, 4], fallback: "team" } });
    assert.deepEqual(skills.validateSkillCriteria({ language: "ticket", fallback: "queue" }), { ok: true, value: { language: "ticket", skill_ids: [], fallback: "queue" } });
    assert.equal(skills.validateSkillCriteria({}).ok, false);
    assert.equal(skills.validateSkillCriteria({ language: "xx" }).ok, false);
    assert.equal(skills.validateSkillCriteria({ skill_ids: [0] }).ok, false);
    assert.equal(skills.validateSkillCriteria({ skill_ids: Array.from({ length: 11 }, (_, i) => i + 1) }).ok, false);
    assert.equal(skills.validateSkillCriteria(null).ok, false);
  });

  test("validateAgentTags", () => {
    assert.deepEqual(skills.validateAgentTags({ skill_ids: [1, 1, 2], languages: ["fr", "fr"] }), { ok: true, value: { skill_ids: [1, 2], languages: ["fr"] } });
    assert.deepEqual(skills.validateAgentTags({}), { ok: true, value: { skill_ids: [], languages: [] } });
    assert.equal(skills.validateAgentTags({ languages: ["french"] }).ok, false);
    assert.equal(skills.validateAgentTags({ skill_ids: "1" }).ok, false);
  });

  test("agentMatches: every skill, and the language (its own or the ticket's)", () => {
    const ana = { skill_ids: [1, 2], languages: ["en", "fr"] };
    const c = (language: string | null, skill_ids: number[] = []) => ({ language, skill_ids, fallback: "team" as const });
    assert.ok(skills.agentMatches(ana, c("fr", [1]), null));
    assert.ok(!skills.agentMatches(ana, c("de", [1]), null));
    assert.ok(!skills.agentMatches(ana, c("fr", [1, 3]), null));
    assert.ok(skills.agentMatches(ana, c("ticket"), "fr"));
    assert.ok(!skills.agentMatches(ana, c("ticket"), "de"));
    assert.ok(skills.agentMatches(ana, c("ticket", [2]), null), "an unknown ticket language asks only for the skills");
    assert.ok(!skills.agentMatches(undefined, c(null, [1]), null));
    assert.equal(skills.requiredLanguage(c("ticket"), null), null);
  });

  test("pickLongestWaiting: never assigned first, then the oldest last assignment, then the lowest id", () => {
    assert.equal(skills.pickLongestWaiting([]), null);
    assert.equal(skills.pickLongestWaiting([{ user_id: 3, last_assigned_at: "2026-11-01T10:00:00Z" }, { user_id: 5, last_assigned_at: null }]), 5);
    assert.equal(skills.pickLongestWaiting([{ user_id: 3, last_assigned_at: "2026-11-02T10:00:00Z" }, { user_id: 5, last_assigned_at: "2026-11-01T10:00:00Z" }]), 5);
    assert.equal(skills.pickLongestWaiting([{ user_id: 7, last_assigned_at: null }, { user_id: 4, last_assigned_at: null }]), 4);
  });

  test("the words", () => {
    const name = (id: number) => ({ 1: "Mac", 2: "Networking" })[id] ?? "?";
    assert.equal(skills.criteriaText({ language: "fr", skill_ids: [1] }, name), "speaks French and knows Mac");
    assert.equal(skills.criteriaText({ language: null, skill_ids: [1, 2] }, name), "knows Mac and Networking");
    assert.equal(skills.criteriaText({ language: "ticket", skill_ids: [] }, name), "speaks the ticket's language");
    assert.equal(skills.criteriaText({ language: "ticket", skill_ids: [] }, name, "de"), "speaks German");
    assert.equal(skills.matchTodayText(["Ana Kowalski", "Marie Bernard"]), "2 agents match today: Ana Kowalski, Marie Bernard.");
    assert.equal(skills.matchTodayText(["Ana Kowalski"]), "1 agent matches today: Ana Kowalski.");
    assert.equal(skills.matchTodayText([]), "No agent matches today.");
  });

  test("the rule action and the ticket language condition", () => {
    const a = shared.validateAction({ assign: "skills", skills: { language: "fr", skill_ids: [7] } });
    assert.ok(a.ok);
    assert.deepEqual(a.ok && a.value.skills, { language: "fr", skill_ids: [7], fallback: "team" });
    assert.equal(shared.validateAction({ assign: "skills" }).ok, false);
    const c = shared.validateConditions({ match: "all", rules: [frenchCond] });
    assert.ok(c.ok);
    const base: HdAssignFacts = {
      source: "portal",
      automated: false,
      integration_id: null,
      request_type_id: null,
      team_id: 1,
      priority: "normal",
      category: "",
      tags: [],
      subject: "",
      body: "",
      answers: {},
      requester: null,
      open: true,
      language: "fr",
    };
    assert.ok(shared.conditionHolds({ field: "language", op: "equals", value: ["fr", "es"] }, base));
    assert.ok(!shared.conditionHolds({ field: "language", op: "equals", value: ["de"] }, base));
    assert.ok(shared.conditionHolds({ field: "language", op: "not_equals", value: ["de"] }, base));
    assert.ok(shared.conditionHolds({ field: "language", op: "is_empty" }, { ...base, language: null }));
    assert.ok(shared.conditionHolds({ field: "language", op: "not_empty" }, base));
    const d = engine.evaluateRules(
      [{ id: 1, name: "French", position: 0, enabled: 1, scope_team_id: null, conditions: { match: "all", rules: [frenchCond as never] }, action: { assign: "skills", skills: { language: "fr", skill_ids: [], fallback: "queue" } }, stop: 1, created_by: null, created_at: "", updated_at: "" }],
      base
    );
    assert.equal(d.assign, "skills");
    assert.deepEqual(d.skills, { language: "fr", skill_ids: [], fallback: "queue" });
    assert.equal(shared.methodPhrase("skills", "French"), "by rule “French”");
    assert.equal(shared.assignerName("skills", "French"), "Rule “French”");
  });
});

// --- The ticket's language -----------------------------------------------------------------

describe("ticket language", () => {
  test("detected from the subject and first message; a set language is left alone", async () => {
    const fr = await ticket({ team: null, subject: "VPN", body: FR });
    assert.deepEqual(await skillStore.assignLanguageOnCreate(fr.id), { language: "fr", source: "detected" });
    assert.deepEqual(await languageOf(fr.id), { language: "fr", language_source: "detected" });
    await pool().query("UPDATE hd_tickets SET language = 'de', language_source = 'agent' WHERE id = $1", [fr.id]);
    assert.equal((await skillStore.assignLanguageOnCreate(fr.id)).language, "de");
    const short = await ticket({ team: null, subject: "help", body: "VPN?" });
    assert.deepEqual(await skillStore.assignLanguageOnCreate(short.id), { language: null, source: "" });
  });

  test("the requester's directory entry wins over the message: the synced value, an admin's override over it; hidden entries and admins-only fields are never read", async () => {
    const key = STAMP.replace(/-/g, "_");
    // As the Entra sync writes it: into `synced`, never `custom`.
    const dp = await pool().query(`INSERT INTO directory_people (name, email, synced, custom) VALUES ($1, $2, $3, '{}') RETURNING id`, [
      "Rae Requester",
      `${STAMP}-req@example.test`,
      JSON.stringify({ [key]: "de-CH" }),
    ]);
    const personId = dp.rows[0].id as number;
    await pool().query("UPDATE users SET directory_person_id = $1 WHERE id = $2", [personId, P.req.id]);
    const field = await pool().query(`INSERT INTO directory_fields (key, label, graph_path) VALUES ($1, 'Language', 'preferredLanguage') RETURNING id`, [key]);
    const fieldIds = [field.rows[0].id as number];
    try {
      const t = await ticket({ team: null, requester: "req", subject: "VPN", body: FR });
      assert.deepEqual(await skillStore.assignLanguageOnCreate(t.id), { language: "de", source: "directory" }, "the synced value");
      // An admin's manual value overrides the synced one, as the directory shows it.
      await pool().query("UPDATE directory_people SET custom = $2 WHERE id = $1", [personId, JSON.stringify({ [key]: "Español" })]);
      const t1 = await ticket({ team: null, requester: "req", subject: "VPN", body: FR });
      assert.deepEqual(await skillStore.assignLanguageOnCreate(t1.id), { language: "es", source: "directory" }, "the manual override");
      // An admins-only field is never a source (its value would show to every agent on the ticket).
      await pool().query("UPDATE directory_fields SET visibility = 'admins' WHERE id = $1", [fieldIds[0]]);
      const t2 = await ticket({ team: null, requester: "req", subject: "VPN", body: FR });
      assert.deepEqual(await skillStore.assignLanguageOnCreate(t2.id), { language: "fr", source: "detected" }, "admins-only fields are skipped");
      await pool().query("UPDATE directory_fields SET visibility = 'everyone' WHERE id = $1", [fieldIds[0]]);
      await pool().query("UPDATE directory_people SET hidden = 1 WHERE id = $1", [personId]);
      const t3 = await ticket({ team: null, requester: "req", subject: "VPN", body: FR });
      assert.deepEqual(await skillStore.assignLanguageOnCreate(t3.id), { language: "fr", source: "detected" }, "hidden entries are skipped");
    } finally {
      await pool().query("DELETE FROM directory_fields WHERE id = ANY($1)", [fieldIds]);
      await pool().query("UPDATE users SET directory_person_id = NULL WHERE id = $1", [P.req.id]);
      await pool().query("DELETE FROM directory_people WHERE id = $1", [personId]);
    }
  });

  test("an agent sets it: an internal line on the timeline and an audit row; others can't", async () => {
    await member("desk", "plain");
    try {
      const t = await ticket({ team: "desk", subject: "Printer", body: EN });
      await skillStore.assignLanguageOnCreate(t.id);
      const get = await call(ticketLanguageRoute.GET, req(`/tickets/${t.number}/language`, P.plain.session), { number: String(t.number) });
      assert.equal(get.status, 200);
      assert.equal(get.body.language, "en");
      assert.equal(get.body.source_label, "Detected from the first message");
      const r = await call(ticketLanguageRoute.PATCH, req(`/tickets/${t.number}/language`, P.plain.session, { language: "fr" }, "PATCH"), { number: String(t.number) });
      assert.equal(r.status, 200);
      assert.equal(r.body.language, "fr");
      assert.equal(r.body.source, "agent");
      assert.ok((await notesOf(t.id)).includes("Pat Agent changed the language from English to French"));
      const audit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.language_changed' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.plain.id]);
      assert.deepEqual(audit.rows[0].details, { from: "en", to: "fr" });
      // The same value again: no new line.
      const n = (await notesOf(t.id)).length;
      await call(ticketLanguageRoute.PATCH, req(`/tickets/${t.number}/language`, P.plain.session, { language: "fr" }, "PATCH"), { number: String(t.number) });
      assert.equal((await notesOf(t.id)).length, n);
      assert.equal((await call(ticketLanguageRoute.PATCH, req(`/tickets/${t.number}/language`, P.plain.session, { language: "xx" }, "PATCH"), { number: String(t.number) })).status, 400);
      // Someone outside the team (and a requester) never sees it.
      assert.equal((await call(ticketLanguageRoute.PATCH, req(`/tickets/${t.number}/language`, P.jonas.session, { language: "de" }, "PATCH"), { number: String(t.number) })).status, 404);
      assert.equal((await call(ticketLanguageRoute.GET, req(`/tickets/${t.number}/language`, P.req.session), { number: String(t.number) })).status, 403);
      // The requester-facing message list never carries the internal line.
      const { requesterMessages } = await import("../src/lib/helpdesk/access");
      const msgs = (await pool().query("SELECT * FROM hd_messages WHERE ticket_id = $1", [t.id])).rows;
      assert.ok(!requesterMessages(msgs).some((m) => /language/.test(m.body)));
    } finally {
      await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T.desk, P.plain.id]);
    }
  });
});

// --- Skills, languages and tags ----------------------------------------------------------------

describe("skills and languages settings", () => {
  test("the overview: counts, tags, and who may change what", async () => {
    const mgr = await call(skillsRoute.GET, req("/admin/skills", P.mgr.session));
    assert.equal(mgr.status, 200);
    assert.equal(mgr.body.can_manage_lists, true);
    const mac = mgr.body.skills.find((s: { id: number }) => s.id === S.Mac);
    assert.equal(mac.agent_count, 1);
    const ana = mgr.body.agents.find((a: { user_id: number }) => a.user_id === P.ana.id);
    assert.deepEqual(ana.skill_ids, [S.Mac]);
    assert.deepEqual(ana.languages, ["en", "fr"]);
    assert.deepEqual(ana.teams, [`${STAMP} desk`]);
    assert.equal(ana.manageable, true);

    const lead = await call(skillsRoute.GET, req("/admin/skills", P.lead.session));
    assert.equal(lead.status, 200);
    assert.equal(lead.body.can_manage_lists, false);
    assert.equal(lead.body.agents.find((a: { user_id: number }) => a.user_id === P.ana.id).manageable, true);
    assert.equal(lead.body.agents.find((a: { user_id: number }) => a.user_id === P.jonas.id).manageable, false, "a lead tags only their teams' people");

    assert.equal((await call(skillsRoute.GET, req("/admin/skills", P.plain.session))).status, 403);
  });

  test("skills: add, duplicate, rename, gates, audit", async () => {
    const add = await call(skillsRoute.POST, req("/admin/skills", P.mgr.session, { name: `  Networking   ${STAMP} ` }));
    assert.equal(add.status, 201);
    skillIds.push(add.body.skill.id);
    assert.equal(add.body.skill.name, `Networking ${STAMP}`);
    assert.equal((await call(skillsRoute.POST, req("/admin/skills", P.mgr.session, { name: `networking ${STAMP}` }))).status, 409);
    assert.equal((await call(skillsRoute.POST, req("/admin/skills", P.mgr.session, { name: "" }))).status, 400);
    assert.equal((await call(skillsRoute.POST, req("/admin/skills", P.lead.session, { name: `Lead ${STAMP}` }))).status, 403);
    const ren = await call(skillRoute.PATCH, req(`/admin/skills/${add.body.skill.id}`, P.mgr.session, { name: `Networks ${STAMP}` }, "PATCH"), { id: String(add.body.skill.id) });
    assert.equal(ren.status, 200);
    assert.equal((await call(skillRoute.PATCH, req(`/admin/skills/${add.body.skill.id}`, P.mgr.session, { name: `Mac ${STAMP}` }, "PATCH"), { id: String(add.body.skill.id) })).status, 409);
    const del = await call(skillRoute.DELETE, req(`/admin/skills/${add.body.skill.id}`, P.mgr.session, undefined, "DELETE"), { id: String(add.body.skill.id) });
    assert.equal(del.status, 200);
    const actions = (await pool().query("SELECT action FROM audit_log WHERE actor_id = $1 AND action LIKE 'helpdesk.skills.%' ORDER BY id", [P.mgr.id])).rows.map((r) => r.action);
    for (const a of ["helpdesk.skills.skill_created", "helpdesk.skills.skill_renamed", "helpdesk.skills.skill_deleted"]) assert.ok(actions.includes(a), a);
  });

  test("tags: a lead tags their teams' people, not others; unknown skills and languages are refused", async () => {
    const ok = await call(agentRoute.PUT, req(`/admin/skills/agents/${P.sam.id}`, P.lead.session, { skill_ids: [S.Windows, S.Mac], languages: ["en"] }, "PUT"), { userId: String(P.sam.id) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.tags, { skill_ids: [S.Mac, S.Windows].sort((a, b) => a - b), languages: ["en"] });
    const audit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.skills.agent_updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.lead.id]);
    assert.deepEqual(audit.rows[0].details, { skills_added: [S.Mac], skills_removed: [], languages_added: [], languages_removed: [] });
    assert.equal((await call(agentRoute.PUT, req(`/admin/skills/agents/${P.jonas.id}`, P.lead.session, { skill_ids: [], languages: [] }, "PUT"), { userId: String(P.jonas.id) })).status, 403);
    assert.equal((await call(agentRoute.PUT, req(`/admin/skills/agents/${P.sam.id}`, P.mgr.session, { skill_ids: [2 ** 31 - 2], languages: [] }, "PUT"), { userId: String(P.sam.id) })).status, 409);
    const notAdded = ["ja", "ko", "th"].find((c) => !addedLanguages.includes(c))!;
    const exists = (await pool().query("SELECT 1 FROM hd_languages WHERE code = $1", [notAdded])).rows.length > 0;
    if (!exists) assert.equal((await call(agentRoute.PUT, req(`/admin/skills/agents/${P.sam.id}`, P.mgr.session, { skill_ids: [], languages: [notAdded] }, "PUT"), { userId: String(P.sam.id) })).status, 409);
    assert.equal((await call(agentRoute.PUT, req(`/admin/skills/agents/${P.req.id}`, P.mgr.session, { skill_ids: [], languages: [] }, "PUT"), { userId: String(P.req.id) })).status, 404, "not on the desk");
    await tag("sam", ["Windows"], ["en"]);
  });

  test("a lead tags only whom J's Agents page lets them change: not themselves, not their rank or above", async () => {
    await member("desk", "mgr");
    try {
      const put = (who: string, body: unknown, as = "lead") =>
        call(agentRoute.PUT, req(`/admin/skills/agents/${P[who].id}`, P[as].session, body, "PUT"), { userId: String(P[who].id) });
      assert.equal((await put("lead", { skill_ids: [S.Mac], languages: ["fr"] })).status, 403, "not themselves");
      assert.equal((await put("mgr", { skill_ids: [], languages: [] })).status, 403, "not a higher rank in their team");
      assert.equal((await put("ana", { skill_ids: [S.Mac], languages: ["en", "fr"] })).status, 200);
      const o = await call(skillsRoute.GET, req("/admin/skills", P.lead.session));
      const row = (k: string) => o.body.agents.find((a: { user_id: number }) => a.user_id === P[k].id);
      assert.equal(row("lead").manageable, false);
      assert.equal(row("mgr").manageable, false);
      assert.equal(row("ana").manageable, true);
      // teams.manage tags anyone on the desk.
      assert.equal((await put("mgr", { skill_ids: [], languages: [] }, "mgr")).status, 200);
    } finally {
      await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [T.desk, P.mgr.id]);
      await tag("ana", ["Mac"], ["en", "fr"]);
    }
  });

  test("deleting a skill or removing a language updates the tickets waiting for it, with a note each", async () => {
    const gone = await skill("Gone");
    const queue = async (decision: Record<string, unknown>) => {
      const t = await ticket({ team: "desk", subject: "Wait", body: FR });
      await store.queueTicket(t.id, "test", decision as never, new Date());
      return t;
    };
    const decisionOf = async (id: number) => (await store.getTicketState(id))!.decision as Record<string, any>;
    const only = await queue({ kind: "skills", skills: { language: null, skill_ids: [gone], fallback: "queue" } });
    const both = await queue({ kind: "skills", skills: { language: "fr", skill_ids: [gone, S.Mac], fallback: "queue" } });
    const del = await call(skillRoute.DELETE, req(`/admin/skills/${gone}`, P.mgr.session, undefined, "DELETE"), { id: String(gone) });
    assert.equal(del.status, 200);
    assert.equal((await decisionOf(only.id)).kind, "team_mode");
    assert.equal((await decisionOf(only.id)).skills, undefined);
    assert.match((await notesOf(only.id)).at(-1)!, new RegExp(`^The skill Gone ${STAMP} was removed, so this ticket now waits for the team's turn\.$`));
    assert.deepEqual((await decisionOf(both.id)).skills, { language: "fr", skill_ids: [S.Mac], fallback: "queue" });
    assert.match((await notesOf(both.id)).at(-1)!, /was removed, so this ticket no longer needs it while it waits\.$/);

    const present = new Set((await pool().query<{ code: string }>("SELECT code FROM hd_languages")).rows.map((r) => r.code));
    const code = ["it", "pt", "nl", "sv", "da", "fi", "pl"].find((c) => !present.has(c));
    if (code) {
      await language(code);
      const waiting = await queue({ kind: "skills", skills: { language: code, skill_ids: [S.Mac], fallback: "queue" } });
      const r = await call(languageRoute.DELETE, req(`/admin/skills/languages/${code}`, P.mgr.session, undefined, "DELETE"), { code });
      assert.equal(r.status, 200);
      assert.deepEqual((await decisionOf(waiting.id)).skills, { language: null, skill_ids: [S.Mac], fallback: "queue" });
      addedLanguages.splice(addedLanguages.indexOf(code), 1);
    }
  });

  test("a skill or language a rule needs can't be removed", async () => {
    await rule({ name: `Needs Payroll ${STAMP}`, scope_team_id: T.people, conditions: { match: "all", rules: [stampCond] }, action: { assign: "skills", skills: { language: "de", skill_ids: [S.Payroll] } } });
    try {
      const del = await call(skillRoute.DELETE, req(`/admin/skills/${S.Payroll}`, P.mgr.session, undefined, "DELETE"), { id: String(S.Payroll) });
      assert.equal(del.status, 409);
      assert.match(del.body.error, /Needs Payroll/);
      const lang = await call(languageRoute.DELETE, req(`/admin/skills/languages/de`, P.mgr.session, undefined, "DELETE"), { code: "de" });
      assert.equal(lang.status, 409);
      assert.equal((await call(languagesRoute.POST, req("/admin/skills/languages", P.mgr.session, { code: "klingon" }))).status, 400);
      assert.equal((await call(languagesRoute.POST, req("/admin/skills/languages", P.lead.session, { code: "it" }))).status, 403);
    } finally {
      await dropRules();
    }
  });

  test("a rule's skills must exist and its language must be the workspace's", async () => {
    const missing = "ja";
    const has = (await pool().query("SELECT 1 FROM hd_languages WHERE code = $1", [missing])).rows.length > 0;
    const body = (skills: unknown) => ({ name: `Bad ${STAMP}`, scope_team_id: T.desk, conditions: { match: "all", rules: [stampCond] }, action: { assign: "skills", skills } });
    assert.equal((await call(rulesRoute.POST, req("/admin/assignment/rules", P.mgr.session, body({ skill_ids: [2 ** 31 - 2] })))).status, 400);
    if (!has) {
      const r = await call(rulesRoute.POST, req("/admin/assignment/rules", P.mgr.session, body({ language: missing })));
      assert.equal(r.status, 400);
      assert.match(r.body.error, /Skills and languages/);
    }
    assert.equal((await call(rulesRoute.POST, req("/admin/assignment/rules", P.mgr.session, body({})))).status, 400);
    const choices = await call(rulesRoute.GET, req("/admin/assignment/rules", P.mgr.session));
    assert.ok(choices.body.choices.skills.some((s: { id: number }) => s.id === S.Mac));
    assert.ok(choices.body.choices.languages.some((l: { code: string }) => l.code === "fr"));
  });
});

// --- Routing -------------------------------------------------------------------------------

describe("routing on skills and language", () => {
  test("a French ticket goes to an available French speaker, in turn, through the created hook", async () => {
    await rule({ name: `French speakers ${STAMP}`, scope_team_id: T.desk, conditions: { match: "all", rules: [stampCond, frenchCond] }, action: { assign: "skills", skills: { language: "fr", skill_ids: [] } } });
    try {
      const got: number[] = [];
      for (let i = 0; i < 4; i++) {
        const t = await ticket({ team: "desk", subject: "VPN", body: FR });
        await events.afterTicketCreated({ id: t.id, request_type_id: null, source: "portal", parent_ticket_id: null }, { silent: true });
        assert.equal((await languageOf(t.id)).language, "fr");
        got.push((await assigneeOf(t.id))!);
        assert.equal((await logOf(t.id))[0].method, "skills");
      }
      // Ana and Marie take turns; Sam (English only) never gets one.
      assert.deepEqual(new Set(got), new Set([P.ana.id, P.marie.id]));
      assert.notEqual(got[0], got[1]);
      assert.equal(got[0], got[2]);
      const t = await ticket({ team: "desk", subject: "VPN", body: FR });
      await events.afterTicketCreated({ id: t.id, request_type_id: null, source: "portal", parent_ticket_id: null }, { silent: true });
      const note = (await notesOf(t.id)).find((n) => n.startsWith("Assigned to"))!;
      // The stored note is Markdown-escaped (lib/helpdesk/md-inline escapes every ":").
      assert.match(note, new RegExp(`^Assigned to (Ana Kowalski|Marie Bernard) by rule “French speakers ${STAMP}”\\\\: (Ana|Marie) speaks French\\.$`));
      // An English ticket doesn't match the rule: the team's round robin, which can be Sam.
      const en = await ticket({ team: "desk", subject: "VPN", body: EN });
      await events.afterTicketCreated({ id: en.id, request_type_id: null, source: "portal", parent_ticket_id: null }, { silent: true });
      assert.equal((await languageOf(en.id)).language, "en");
      assert.equal((await logOf(en.id))[0].method, "round_robin");
    } finally {
      await dropRules();
    }
  });

  test("skills and language together; away, paused and capped people are passed over like round robin", async () => {
    await rule({
      name: `French Mac ${STAMP}`,
      scope_team_id: T.desk,
      conditions: { match: "all", rules: [stampCond] },
      action: { assign: "skills", skills: { language: "ticket", skill_ids: [S.Mac], fallback: "team" } },
    });
    try {
      const run = async (body = FR) => {
        const t = await ticket({ team: "desk", subject: "Mac", body });
        await skillStore.assignLanguageOnCreate(t.id);
        const r = await engine.assignTicket(t.id, { trigger: "created" });
        return { t, r };
      };
      let { r } = await run();
      assert.equal(r.user_id, P.ana.id, "only Ana speaks French and knows Mac");
      assert.equal(r.method, "skills");
      // Ana away: nobody matching, so the team's turn decides (Sam or Marie), and the note says why.
      await availability("ana", "away");
      let x = await run();
      assert.equal(x.r.outcome, "assigned");
      assert.notEqual(x.r.user_id, P.ana.id);
      assert.equal(x.r.method, "round_robin");
      assert.match((await notesOf(x.t.id)).at(-1)!, new RegExp(`Nobody who speaks French and knows Mac ${STAMP} was available, so the team's turn decided\\.$`));
      // Paused counts the same.
      await availability("ana", "available");
      await store.setMember(T.desk, P.ana.id, { paused: 1 });
      x = await run();
      assert.notEqual(x.r.user_id, P.ana.id);
      await store.setMember(T.desk, P.ana.id, { paused: 0 });
      // The cap: Ana already has open tickets over the limit.
      await settings("desk", { max_open_per_agent: 1 });
      x = await run();
      assert.notEqual(x.r.user_id, P.ana.id);
      await settings("desk", { max_open_per_agent: null });
      // A German ticket: "the ticket's language" = German; nobody in the team speaks it (Jonas is in another team).
      x = await run("Hallo, mein Mac startet seit heute Morgen nicht mehr. Können Sie mir bitte helfen? Danke");
      assert.notEqual(x.r.user_id, P.jonas.id);
      assert.match((await notesOf(x.t.id)).at(-1)!, new RegExp(`Nobody who speaks German and knows Mac ${STAMP} was available`));
      // Unknown language: only the skill counts.
      x = await run("Mac?");
      assert.equal(x.r.user_id, P.ana.id);
      ({ r } = await run());
      assert.equal(r.user_id, P.ana.id);
    } finally {
      await dropRules();
      await availability("ana", "available");
      await store.setMember(T.desk, P.ana.id, { paused: 0 });
      await settings("desk", { max_open_per_agent: null });
    }
  });

  test("fallback 'wait in the queue': queued with the reason, and the sweep assigns a match once one is back", async () => {
    await rule({
      name: `French queue ${STAMP}`,
      scope_team_id: T.desk,
      conditions: { match: "all", rules: [stampCond] },
      action: { assign: "skills", skills: { language: "fr", skill_ids: [], fallback: "queue" } },
    });
    try {
      await availability("ana", "away");
      await availability("marie", "offline");
      const t = await ticket({ team: "desk", subject: "Queue", body: FR });
      await skillStore.assignLanguageOnCreate(t.id);
      const r = await engine.assignTicket(t.id, { trigger: "created" });
      assert.equal(r.outcome, "queued");
      assert.match(r.reason, /^Nobody who speaks French is available \((Ana is away|Marie is offline)/);
      assert.equal(await assigneeOf(t.id), null);
      const state = await store.getTicketState(t.id);
      assert.equal(state?.decision.kind, "skills");
      // Sam is available but doesn't speak French: the sweep keeps it queued.
      await engine.assignmentSweep(new Date(), { teamIds: [T.desk] });
      assert.equal(await assigneeOf(t.id), null);
      await availability("marie", "available");
      await engine.assignmentSweep(new Date(), { teamIds: [T.desk] });
      assert.equal(await assigneeOf(t.id), P.marie.id);
      assert.equal((await logOf(t.id)).at(-1)!.method, "skills");
    } finally {
      await dropRules();
      await availability("ana", "available");
      await availability("marie", "available");
    }
  });

  test("a skills pick never moves the team's round-robin cursor: the team's turn skips nobody", async () => {
    await rule({ name: `French cursor ${STAMP}`, scope_team_id: T.desk, conditions: { match: "all", rules: [stampCond, frenchCond] }, action: { assign: "skills", skills: { language: "fr", skill_ids: [] } } });
    try {
      const cursor = async () => (await pool().query("SELECT last_user_id, streak FROM hd_assignment_cursor WHERE team_id = $1", [T.desk])).rows[0] ?? null;
      const run = async (body: string) => {
        const t = await ticket({ team: "desk", subject: "Turn", body });
        await skillStore.assignLanguageOnCreate(t.id);
        return engine.assignTicket(t.id, { trigger: "created" });
      };
      const english: number[] = [];
      for (let i = 0; i < 3; i++) {
        const en = await run(EN);
        assert.equal(en.method, "round_robin");
        english.push(en.user_id!);
        const before = await cursor();
        const fr = await run(FR);
        assert.equal(fr.method, "skills");
        assert.deepEqual(await cursor(), before, "the skills pick left the team's cursor alone");
      }
      // The team's turn between French tickets: Ana, Sam and Marie each once, nobody skipped.
      assert.deepEqual([...english].sort((a, b) => a - b), [P.ana.id, P.sam.id, P.marie.id].sort((a, b) => a - b));
    } finally {
      await dropRules();
    }
  });

  test("criteria naming a deleted skill fall back to the team's turn on the retry, never wait for it", async () => {
    const t = await ticket({ team: "desk", subject: "Ghost", body: FR });
    await store.queueTicket(t.id, "test", { kind: "skills", skills: { language: null, skill_ids: [2 ** 31 - 3], fallback: "queue" } } as never, new Date(Date.now() - 60_000));
    await engine.assignmentSweep(new Date(), { teamIds: [T.desk] });
    assert.notEqual(await assigneeOf(t.id), null);
    assert.equal((await logOf(t.id)).at(-1)!.method, "round_robin");
    assert.match((await notesOf(t.id)).at(-1)!, /The rule needs a deleted skill, so the team's turn decided\.$/);
  });

  test("a queued skills ticket in a manual team whose language is unknown: one note, then out of the retry queue", async () => {
    await team("manual");
    await member("manual", "ana");
    const t = await ticket({ team: "manual", subject: "Manual", body: "VPN?" });
    await store.queueTicket(t.id, "test", { kind: "skills", skills: { language: "ticket", skill_ids: [], fallback: "team" } } as never, new Date(Date.now() - 60_000));
    const before = (await notesOf(t.id)).length;
    for (let i = 0; i < 3; i++) await engine.assignmentSweep(new Date(), { teamIds: [T.manual] });
    const notes = await notesOf(t.id);
    assert.equal(notes.length, before + 1, "noted once, not every sweep");
    assert.match(notes.at(-1)!, /needs the ticket's language, which is unknown, and the team assigns by hand, so it waits in the queue\.$/);
    assert.equal((await store.getTicketState(t.id))?.queued_since, null);
    assert.equal(await assigneeOf(t.id), null);
  });

  test("team membership: a matching agent outside the team is never picked", async () => {
    await rule({ name: `German ${STAMP}`, scope_team_id: T.desk, conditions: { match: "all", rules: [stampCond] }, action: { assign: "skills", skills: { language: "de", skill_ids: [], fallback: "queue" } } });
    try {
      const t = await ticket({ team: "desk", subject: "Drucker", body: "Hallo, der Drucker im zweiten Stock geht nicht mehr. Bitte helfen, danke!" });
      await skillStore.assignLanguageOnCreate(t.id);
      const r = await engine.assignTicket(t.id, { trigger: "created" });
      assert.equal(r.outcome, "queued");
      assert.match(r.reason, /^Nobody in the team speaks German$/);
    } finally {
      await dropRules();
    }
  });

  test("Test a ticket explains the match, the fallback and the language", async () => {
    await rule({ name: `French speakers ${STAMP}`, scope_team_id: T.desk, conditions: { match: "all", rules: [stampCond, frenchCond] }, action: { assign: "skills", skills: { language: "fr", skill_ids: [S.Mac] } } });
    try {
      const sample = { subject: `VPN ${STAMP}`, team_id: T.desk, language: "fr", hours: "open" };
      let r = await call(testRoute.POST, req("/admin/assignment/rules/test", P.mgr.session, { sample }));
      assert.equal(r.status, 200);
      assert.match(r.body.outcome, new RegExp(`^Rule “French speakers ${STAMP}” matches: it goes to an agent in ${STAMP} desk who speaks French and knows Mac ${STAMP} \\(Ana Kowalski matches\\): next is Ana Kowalski\\.$`));
      assert.equal(r.body.language.note, "Ticket language: French.");
      await availability("ana", "away");
      r = await call(testRoute.POST, req("/admin/assignment/rules/test", P.mgr.session, { sample }));
      assert.match(r.body.outcome, /finds nobody in .* who speaks French and knows Mac \S+ available now \(Ana is away\), so it falls back to the team's turn and goes round robin in .*: next is /);
      r = await call(testRoute.POST, req("/admin/assignment/rules/test", P.mgr.session, { sample: { ...sample, language: "de" } }));
      assert.ok(r.body.trace.some((l: { matched: boolean; reason: string }) => !l.matched && /Not true: .*Ticket language is French/.test(l.reason)));
      // A real ticket: the language and where it came from.
      const t = await ticket({ team: "desk", subject: "VPN", body: FR });
      await skillStore.assignLanguageOnCreate(t.id);
      r = await call(testRoute.POST, req("/admin/assignment/rules/test", P.mgr.session, { ticket_number: t.number }));
      assert.equal(r.body.language.note, "Ticket language: French (detected from the first message).");
    } finally {
      await dropRules();
      await availability("ana", "available");
    }
  });

  test("the editor's N agents match today", async () => {
    const r = await call(previewRoute.POST, req("/admin/assignment/skills-preview", P.mgr.session, { skills: { language: "fr" }, team_id: T.desk }));
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "2 agents match today: Ana Kowalski, Marie Bernard.");
    await availability("marie", "away");
    try {
      const r2 = await call(previewRoute.POST, req("/admin/assignment/skills-preview", P.mgr.session, { skills: { language: "fr", skill_ids: [] }, team_id: T.desk }));
      assert.equal(r2.body.text, "1 agent matches today: Ana Kowalski.");
      assert.deepEqual(r2.body.unavailable, ["Marie is away"]);
    } finally {
      await availability("marie", "available");
    }
    const byLang = await call(previewRoute.POST, req("/admin/assignment/skills-preview", P.mgr.session, { skills: { language: "ticket" }, team_id: T.desk }));
    assert.match(byLang.body.text, /^Agents who match today, by the ticket's language: /);
    assert.equal(byLang.body.by_language.find((l: { code: string }) => l.code === "fr").count, 2);
    assert.equal((await call(previewRoute.POST, req("/admin/assignment/skills-preview", P.lead.session, { skills: { language: "fr" } }))).status, 403);
    assert.equal((await call(previewRoute.POST, req("/admin/assignment/skills-preview", P.mgr.session, { skills: {} }))).status, 400);
    // Seed scripts: the library call behind it.
    const lib = await skillRoutes.matchPreview({ language: null, skill_ids: [S.Payroll], fallback: "team" }, T.people, null);
    assert.deepEqual(lib.agents.map((a) => a.name), ["Jonas Müller"]);
  });
});

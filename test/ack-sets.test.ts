// Policy sets (D3, 1.14.0): a named, ordered bundle of policies assigned to
// people, groups or everyone as one unit, and to every new account on day
// one when it auto-assigns. Assigning a set writes the same include rules
// (tagged with the set) onto every member policy and reconciles each one,
// so a row it admits reads source 'set'; a member not yet requiring
// confirmation is switched on with the defaults; a member already asking
// everyone who can see its space is left alone (a set never narrows); a new
// account lands on an active auto-assign set's targeted policies through a
// rule naming them; deactivating stops auto-assign and leaves every row;
// deleting leaves the rules (untagged) and the rows; the name is unique
// among active sets, case-insensitively (409).
//
// Fixtures live in a private space granted to a group of this file's own
// people, so no other file's account hook, switch-on or sweep enrols into or
// out of these policies; the workspace's admins still see it (space.read_all
// through the ladder), so counts name this file's people (`mine`) and never
// a bare total. The route handlers are called directly, as
// test/ack-audience.test.ts does: next/headers resolves to a stub serving
// the request under test, lib/ee to a stub granting policy_ack.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-sets.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  createGroup,
  addGroupMember,
  setGroupMembers,
  setSpaceGroups,
  createSession,
  saveAudienceRules,
  getPolicyAudience,
  autoAssignPolicies,
  recordAcknowledgement,
  listVersions,
  ackSummary,
  listMyPolicies,
  listPolicySets,
  getPolicySet,
  policySetCandidates,
  createPolicySet,
  updatePolicySet,
  deletePolicySet,
  assignPolicySet,
  policySetNames,
  PolicySetError,
} from "../src/lib/db";
import { asScope } from "../src/lib/space-scope";
import { newToken } from "../src/lib/password";
import { sanitizeRules } from "../src/lib/audience";
import {
  parseSetInput,
  parseSetPatch,
  parseSetTarget,
  assignEveryoneConfirm,
  switchedOnLine,
  notNarrowedLine,
  progressText,
  setGroupLabel,
  policySetCsvCell,
  POLICY_SET_CSV_COLUMN,
  SET_NAME_TAKEN,
  SET_NOT_FOUND,
  SET_DEACTIVATED,
  SET_DOCS_INVALID,
  SET_TARGET_EMPTY,
  SET_NOTHING_TO_CHANGE,
  SET_NAME_REQUIRED,
  SET_DOCS_RANGE,
  SET_DOCS_INTEGERS,
  SET_TARGET_RANGE,
  SET_TARGET_INTEGERS,
  SET_DESCRIPTION_TOO_LONG,
} from "../src/lib/policy-sets";
import { fixtureQuery, retryOnTeardownRace } from "./support/retry";
import { switchOn } from "./support/assign";

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-sets.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-sets.virtual.js");
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

  const edition = { present: true, features: ["policy_ack"] };
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
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

type Answer = { status: number; body: any };

async function answer(run: () => Promise<Response>, req: Request): Promise<Answer> {
  currentRequest = req;
  try {
    const res = await run();
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function request(method: string, url: string, session: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.44" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures -------------------------------------------------------------------

const STAMP = `acksets-${Date.now()}`;
const HOUR = 60 * 60 * 1000;

let spaceP = 0; // private, granted to G3 (every one of this file's people)
let g1 = 0; // alice
let g2 = 0; // bob
let g3 = 0; // everyone here
const people: Record<string, number> = {};
const userIds: number[] = [];
const docIds: number[] = [];
const setIds: number[] = [];
const sessions: string[] = [];
const titles: Record<string, string> = {};
const docs: Record<string, number> = {};

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");

async function newPerson(tag: string, role = "viewer"): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `${tag[0].toUpperCase()}${tag.slice(1)} ${STAMP}`, `${STAMP}-${tag}@example.test`, role]
  );
  people[tag] = r.rows[0].id;
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

/** A published document in the private space; switched on (space mode) unless `required: false`. */
async function newDoc(tag: string, title: string, opts: { required?: boolean; status?: "published" | "draft" } = {}): Promise<number> {
  const full = `${STAMP} ${title}`;
  const doc = await createDocument({
    space_id: spaceP,
    title: full,
    type: "policy",
    status: opts.status ?? "published",
    content: LONG_TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  if (opts.required !== false && (opts.status ?? "published") === "published") {
    // editDefault / recertMonths null: never read the shared workspace setting.
    await switchOn(doc.id, { editDefault: null, recertMonths: null });
  }
  docIds.push(doc.id);
  docs[tag] = doc.id;
  titles[tag] = full;
  return doc.id;
}

/** This file's people among a list of user ids, as tags, sorted. */
function mine(ids: number[]): string[] {
  const byId = new Map(Object.entries(people).map(([tag, id]) => [id, tag]));
  return ids
    .map((id) => byId.get(id))
    .filter((t): t is string => Boolean(t))
    .sort();
}

async function openRows(docId: number): Promise<{ user_id: number; source: string; due_at: string | null }[]> {
  const r = await pool().query(
    "SELECT user_id, source, due_at FROM policy_assignments WHERE document_id = $1 AND removed_at IS NULL AND exempt_at IS NULL ORDER BY user_id",
    [docId]
  );
  return r.rows;
}

async function row(docId: number, userId: number): Promise<{ source: string; removed_at: string | null; due_at: string | null } | undefined> {
  const r = await pool().query("SELECT source, removed_at, due_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [docId, userId]);
  return r.rows[0];
}

async function rules(docId: number): Promise<{ kind: string; ref: string; effect: string; set_id: number | null }[]> {
  const r = await pool().query("SELECT kind, ref, effect, set_id FROM policy_audience_rules WHERE document_id = $1 ORDER BY id", [docId]);
  return r.rows;
}

async function requestRows(docId: number): Promise<{ user_ids: number[] | null; source: string }[]> {
  const r = await pool().query(
    "SELECT user_ids, source FROM ack_outbox WHERE document_id = $1 AND mode = 'request' AND done_at IS NULL ORDER BY id",
    [docId]
  );
  return r.rows;
}

async function auditRows(action: string, targetId: number): Promise<{ details: Record<string, unknown> }[]> {
  const r = await pool().query("SELECT details FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id", [action, String(targetId)]);
  return r.rows;
}

const actor = () => ({ id: people.mgr, name: `Mgr ${STAMP}` });

function track(set: { id: number }): number {
  if (!setIds.includes(set.id)) setIds.push(set.id);
  return set.id;
}

const DAY = 24 * HOUR;
const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id",
    [`Sets P ${STAMP}`, `${STAMP}-p`]
  );
  spaceP = sp.rows[0].id;
  for (const tag of ["alice", "bob", "carol"]) await newPerson(tag);
  await newPerson("mgr", "admin");
  g1 = (await createGroup({ name: `${STAMP} G1` })).id;
  g2 = (await createGroup({ name: `${STAMP} G2` })).id;
  g3 = (await createGroup({ name: `${STAMP} G3` })).id;
  await addGroupMember(g1, people.alice);
  await addGroupMember(g2, people.bob);
  await setGroupMembers(g3, Object.values(people));
  await setSpaceGroups(spaceP, [g3]);

  await newDoc("aup", "Acceptable use");
  await newDoc("sec", "Security basics");
  await newDoc("exp", "Expenses", { required: false });
  await newDoc("travel", "Travel");
  await newDoc("coc", "Code of conduct");
  await newDoc("handbook", "Handbook");
  await newDoc("notauto", "Optional reading");
  await newDoc("draft", "Draft only", { status: "draft" });
  await saveAudienceRules(docs.sec, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: g1 }]) });
  await saveAudienceRules(docs.travel, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "user", ref: people.bob }]) });
  await saveAudienceRules(docs.coc, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: g1 }]) });
  await saveAudienceRules(docs.handbook, { assign_new_members: false });
  await saveAudienceRules(docs.notauto, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: g1 }]) });
});

after(async () => {
  await fixtureQuery("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  // A welcome row is keyed to the joiner's earliest-due policy, which may be another file's: by person too.
  for (const id of userIds) await fixtureQuery("DELETE FROM ack_outbox WHERE user_ids @> $1::jsonb", [JSON.stringify([id])]);
  await fixtureQuery("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  // Each id list paired with its target type: documents, users and sets are
  // separate sequences, so a bare target_id would delete another file's row.
  await fixtureQuery(
    `DELETE FROM audit_log WHERE (action LIKE 'ack.%' OR action LIKE 'document.ack%')
       AND ((target_type = 'document' AND target_id = ANY($1))
            OR (target_type = 'user' AND target_id = ANY($2))
            OR (target_type = 'policy_set' AND target_id = ANY($3)))`,
    [docIds.map(String), userIds.map(String), setIds.map(String)]
  );
  await fixtureQuery("DELETE FROM policy_sets WHERE id = ANY($1) OR name LIKE $2", [setIds, `${STAMP}%`]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM groups WHERE id = ANY($1)", [[g1, g2, g3]]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = $1", [spaceP]);
});

// --- The pure module --------------------------------------------------------------

describe("lib/policy-sets: the parsers and the copy", () => {
  test("parseSetInput names the first problem, trims and collapses the name, dedupes the ids in order, defaults auto-assign on", () => {
    assert.deepEqual(parseSetInput(null), { ok: false, error: "Send a JSON object." });
    assert.deepEqual(parseSetInput({ doc_ids: [1] }), { ok: false, error: SET_NAME_REQUIRED });
    assert.deepEqual(parseSetInput({ name: "x".repeat(121), doc_ids: [1] }), { ok: false, error: SET_NAME_REQUIRED });
    assert.deepEqual(parseSetInput({ name: "Onboarding", description: "y".repeat(1001), doc_ids: [1] }), { ok: false, error: SET_DESCRIPTION_TOO_LONG });
    assert.deepEqual(parseSetInput({ name: "Onboarding" }), { ok: false, error: SET_DOCS_RANGE });
    assert.deepEqual(parseSetInput({ name: "Onboarding", doc_ids: [] }), { ok: false, error: SET_DOCS_RANGE });
    assert.deepEqual(parseSetInput({ name: "Onboarding", doc_ids: Array.from({ length: 101 }, (_, i) => i + 1) }), { ok: false, error: SET_DOCS_RANGE });
    assert.deepEqual(parseSetInput({ name: "Onboarding", doc_ids: [1, "2"] }), { ok: false, error: SET_DOCS_INTEGERS });
    assert.deepEqual(parseSetInput({ name: "Onboarding", doc_ids: [1], assign_new_members: "yes" }), {
      ok: false,
      error: "'assign_new_members' must be true or false.",
    });
    assert.deepEqual(parseSetInput({ name: "  New   starter  pack ", description: " Day one ", doc_ids: [3, 1, 3, 2] }), {
      ok: true,
      value: { name: "New starter pack", description: "Day one", doc_ids: [3, 1, 2], assign_new_members: true },
    });
  });

  test("parseSetPatch takes any subset and refuses an empty one; parseSetTarget caps the lists and needs a target", () => {
    assert.deepEqual(parseSetPatch({}), { ok: false, error: SET_NOTHING_TO_CHANGE });
    assert.deepEqual(parseSetPatch({ active: "no" }), { ok: false, error: "'active' must be true or false." });
    assert.deepEqual(parseSetPatch({ name: " Annual pack ", active: false }), { ok: true, value: { name: "Annual pack", active: false } });
    assert.deepEqual(parseSetPatch({ doc_ids: [2, 2, 1] }), { ok: true, value: { doc_ids: [2, 1] } });

    assert.deepEqual(parseSetTarget({}), { ok: false, error: SET_TARGET_EMPTY });
    assert.deepEqual(parseSetTarget({ user_ids: [], group_ids: [] }), { ok: false, error: SET_TARGET_EMPTY });
    assert.deepEqual(parseSetTarget({ user_ids: ["7"] }), { ok: false, error: SET_TARGET_INTEGERS });
    assert.deepEqual(parseSetTarget({ group_ids: Array.from({ length: 201 }, (_, i) => i + 1) }), { ok: false, error: SET_TARGET_RANGE });
    assert.deepEqual(parseSetTarget({ everyone: 1 }), { ok: false, error: "'everyone' must be true or false." });
    assert.deepEqual(parseSetTarget({ user_ids: [5, 5], group_ids: [2] }), { ok: true, value: { user_ids: [5], group_ids: [2], everyone: false } });
    assert.deepEqual(parseSetTarget({ everyone: true, user_ids: [5] }), { ok: true, value: { user_ids: [], group_ids: [], everyone: true } });
  });

  test("the copy reads in the glossary's words and the CSV cell joins the names", () => {
    assert.equal(assignEveryoneConfirm("New starter onboarding", 8), 'Assign "New starter onboarding" (8 policies) to every active member?');
    assert.equal(assignEveryoneConfirm("Annual", 1), 'Assign "Annual" (1 policy) to every active member?');
    assert.equal(switchedOnLine(2), "These 2 documents will start requiring confirmation");
    assert.equal(switchedOnLine(1), "This document will start requiring confirmation");
    assert.equal(notNarrowedLine(3), "These 3 policies currently apply to everyone who can see their space; assigning the set will not narrow them");
    assert.equal(progressText({ required: 40, confirmed: 35, overdue: 6, pct: 87 }), "87% · 6 overdue");
    assert.equal(progressText({ required: 40, confirmed: 40, overdue: 0, pct: 100 }), "100%");
    assert.equal(progressText({ required: 0, confirmed: 0, overdue: 0, pct: 0 }), "Nobody asked yet");
    assert.equal(setGroupLabel("New starter onboarding", 3, 8), "New starter onboarding · 3 of 8 done");
    assert.equal(POLICY_SET_CSV_COLUMN, "set");
    assert.equal(policySetCsvCell(["Annual", "New starter onboarding"]), "Annual; New starter onboarding");
    assert.equal(policySetCsvCell(undefined), "");
  });
});

// --- The data layer ---------------------------------------------------------------

describe("create, order and update", () => {
  test("a set keeps its policies in the given order with their standing, the name is unique among active sets, and only published unretired documents are allowed", async () => {
    const s1 = await createPolicySet(
      { name: `${STAMP} Onboarding pack`, description: "Day one", doc_ids: [docs.sec, docs.exp, docs.travel], assign_new_members: true },
      actor()
    );
    track(s1);
    assert.equal(s1.active, 1);
    assert.equal(s1.assign_new_members, 1);
    assert.equal(s1.deactivated_at, null);
    assert.deepEqual(
      s1.docs.map((d) => [d.id, d.position, d.ack_required]),
      [
        [docs.sec, 0, 1],
        [docs.exp, 1, 0],
        [docs.travel, 2, 1],
      ],
      "the members in the given order, with whether each requires confirmation yet"
    );
    assert.equal(s1.docs[0].title, titles.sec);
    assert.equal(s1.docs[0].space_name, `Sets P ${STAMP}`);
    // Progress over the members' open rows: alice on Security (G1), bob on Travel (named); Expenses asks nobody yet.
    assert.deepEqual(s1.progress, { required: 2, confirmed: 0, overdue: 0, pct: 0 });

    await assert.rejects(
      createPolicySet({ name: `${STAMP} ONBOARDING pack`, description: "", doc_ids: [docs.aup], assign_new_members: true }, actor()),
      (e: unknown) => e instanceof PolicySetError && e.status === 409 && e.message === SET_NAME_TAKEN,
      "the name is taken, whatever the case"
    );
    await assert.rejects(
      createPolicySet({ name: `${STAMP} Drafts`, description: "", doc_ids: [docs.aup, docs.draft], assign_new_members: true }, actor()),
      (e: unknown) => e instanceof PolicySetError && e.status === 400 && e.message === SET_DOCS_INVALID,
      "a draft is not a policy"
    );
    assert.equal((await pool().query("SELECT COUNT(*)::int AS n FROM policy_sets WHERE name LIKE $1", [`${STAMP}%`])).rows[0].n, 1, "nothing was created by the refusals");

    const changed = await updatePolicySet(s1.id, { name: `${STAMP} Onboarding`, description: "Day one, in order", doc_ids: [docs.travel, docs.sec] });
    assert.ok(changed);
    assert.equal(changed!.before.name, `${STAMP} Onboarding pack`);
    assert.equal(changed!.after.name, `${STAMP} Onboarding`);
    assert.equal(changed!.after.description, "Day one, in order");
    assert.deepEqual(
      changed!.after.docs.map((d) => [d.id, d.position]),
      [
        [docs.travel, 0],
        [docs.sec, 1],
      ],
      "the list is replaced in the new order"
    );
    assert.equal(await updatePolicySet(999_999_999, { name: "x" }), null, "an unknown set");
    const listed = (await listPolicySets()).find((s) => s.id === s1.id);
    assert.ok(listed, "the set is listed");
    assert.deepEqual(listed!.docs.map((d) => d.id), [docs.travel, docs.sec]);
    assert.deepEqual((await getPolicySet(s1.id))!.docs.map((d) => d.id), [docs.travel, docs.sec]);
    const candidates = await policySetCandidates();
    assert.ok(candidates.some((c) => c.id === docs.exp && c.ack_required === 0), "a published document not yet requiring confirmation is a candidate");
    assert.ok(!candidates.some((c) => c.id === docs.draft), "a draft is not");
  });
});

describe("assigning a set", () => {
  let s2 = 0;

  test("assigning to people and a group writes one tagged rule per policy and reconciles with source 'set', switches on a member not yet required, and leaves a space-mode member alone", async () => {
    s2 = track(await createPolicySet({ name: `${STAMP} Security basics`, description: "", doc_ids: [docs.aup, docs.sec, docs.exp], assign_new_members: false }, actor()));
    const r = await retryOnTeardownRace(() => assignPolicySet(s2, { user_ids: [people.carol], group_ids: [g2], everyone: false }, actor(), { origin: "https://docs.example.test" }));
    assert.equal(r.policies, 3);
    assert.equal(r.people, 2, "carol and bob (G2)");
    assert.deepEqual(r.switched_on, [titles.exp], "Expenses did not require confirmation yet");
    assert.deepEqual(r.not_narrowed, [titles.aup], "Acceptable use asks everyone who can see the space");
    assert.equal(r.added, 2, "Security gained carol and bob; the switched-on member counts at delivery");

    // Acceptable use: untouched.
    assert.equal((await getPolicyAudience(docs.aup))!.audience_mode, "space");
    assert.deepEqual(await rules(docs.aup), []);
    assert.equal((await row(docs.aup, people.carol))!.source, "space");
    assert.deepEqual(await requestRows(docs.aup), [], "nobody is told about a policy that did not change");

    // Security: the set's two rules beside the manager's group rule; carol and bob asked with source 'set'; alice's row kept.
    assert.deepEqual(await rules(docs.sec), [
      { kind: "group", ref: String(g1), effect: "include", set_id: null },
      { kind: "user", ref: String(people.carol), effect: "include", set_id: s2 },
      { kind: "group", ref: String(g2), effect: "include", set_id: s2 },
    ]);
    assert.equal((await getPolicyAudience(docs.sec))!.audience_mode, "targeted");
    const sec = await openRows(docs.sec);
    assert.deepEqual(mine(sec.map((x) => x.user_id)), ["alice", "bob", "carol"]);
    assert.equal((await row(docs.sec, people.alice))!.source, "space", "an open row keeps its source");
    assert.equal((await row(docs.sec, people.bob))!.source, "set");
    assert.equal((await row(docs.sec, people.carol))!.source, "set");
    const carolDue = at((await row(docs.sec, people.carol))!.due_at);
    assert.ok(carolDue > Date.now() + 13 * DAY && carolDue < Date.now() + 15 * DAY, "added to an audience: the new-joiner days");
    const told = await requestRows(docs.sec);
    assert.equal(told.length, 1, "one request row for the people the reconcile added");
    assert.deepEqual([...(told[0].user_ids ?? [])].sort(), [people.bob, people.carol].sort());
    assert.equal(told[0].source, "manual");

    // Expenses: switched on with the stored audience, the actor as requester, one request row naming nobody (everyone pending at delivery).
    const exp = (await pool().query("SELECT ack_required FROM documents WHERE id = $1", [docs.exp])).rows[0];
    assert.equal(exp.ack_required, 1);
    const settings = (await pool().query("SELECT audience_mode, requested_by FROM policy_settings WHERE document_id = $1", [docs.exp])).rows[0];
    assert.deepEqual(settings, { audience_mode: "targeted", requested_by: people.mgr });
    assert.deepEqual(await rules(docs.exp), [
      { kind: "user", ref: String(people.carol), effect: "include", set_id: s2 },
      { kind: "group", ref: String(g2), effect: "include", set_id: s2 },
    ]);
    const expRows = await openRows(docs.exp);
    assert.deepEqual(mine(expRows.map((x) => x.user_id)), ["bob", "carol"]);
    assert.ok(expRows.every((x) => x.source === "set"), "the switch-on's reconcile reads the set's rules");
    assert.deepEqual(await requestRows(docs.exp), [{ user_ids: null, source: "manual" }]);
  });

  test("a Settings-tab save keeps the set's rules: the manager's rules are replaced, the tagged ones stay, and dropping the manager's rule closes only the people it alone admitted", async () => {
    // What the card sends: the manager's rule only (the set's are not on it).
    await saveAudienceRules(docs.sec, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: g1 }]) });
    const byRef = (rs: { kind: string; ref: string; set_id: number | null }[]) =>
      rs.map((r) => [r.kind, r.ref, r.set_id]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    assert.deepEqual(
      byRef(await rules(docs.sec)),
      byRef([
        { kind: "group", ref: String(g1), set_id: null },
        { kind: "user", ref: String(people.carol), set_id: s2 },
        { kind: "group", ref: String(g2), set_id: s2 },
      ]),
      "the manager's rule rewritten untagged; the set's two kept with their tag"
    );
    assert.equal((await row(docs.sec, people.carol))!.removed_at, null, "carol stays asked through the set");
    assert.equal((await row(docs.sec, people.bob))!.removed_at, null, "bob stays asked through the set's group");

    // The manager drops their own rule: alice (G1 only) goes; the set's people stay.
    await saveAudienceRules(docs.sec, { audience_mode: "targeted", rules: [] });
    assert.deepEqual(byRef(await rules(docs.sec)), byRef([
      { kind: "user", ref: String(people.carol), set_id: s2 },
      { kind: "group", ref: String(g2), set_id: s2 },
    ]));
    assert.ok((await row(docs.sec, people.alice))!.removed_at, "alice's row is closed");
    assert.equal((await row(docs.sec, people.bob))!.removed_at, null);
    assert.equal((await row(docs.sec, people.carol))!.removed_at, null);
  });

  test("editing a policy out of a set untags that policy's rules in the same save (its people stay as plain rules); a member kept keeps its tags; rows and sources are untouched", async () => {
    const changed = await updatePolicySet(s2, { doc_ids: [docs.aup, docs.exp] });
    assert.deepEqual(changed!.after.docs.map((d) => d.id), [docs.aup, docs.exp]);
    assert.deepEqual(
      (await rules(docs.sec)).map((r) => [r.kind, r.ref, r.set_id]),
      [
        ["user", String(people.carol), null],
        ["group", String(g2), null],
      ],
      "Security left the set: its rules are the Settings tab's now"
    );
    assert.deepEqual(
      (await rules(docs.exp)).map((r) => [r.kind, r.ref, r.set_id]),
      [
        ["user", String(people.carol), s2],
        ["group", String(g2), s2],
      ],
      "Expenses is still a member: its rules keep the tag"
    );
    assert.equal((await row(docs.sec, people.bob))!.removed_at, null, "the rows stay");
    assert.equal((await row(docs.sec, people.bob))!.source, "set", "an open row keeps its source");
    assert.equal((await row(docs.sec, people.carol))!.removed_at, null);
    assert.deepEqual((await policySetNames([docs.sec])).get(docs.sec), [`${STAMP} Onboarding`], "Security names only the set it is still in");

    // Now a plain rule, the Settings tab can drop it: carol goes.
    await saveAudienceRules(docs.sec, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: g2 }]) });
    assert.ok((await row(docs.sec, people.carol))!.removed_at, "an untagged rule is the card's to remove");
    assert.equal((await row(docs.sec, people.bob))!.removed_at, null);

    // Back in the set (the later tests assign it with three members); re-adding does not re-tag.
    await updatePolicySet(s2, { doc_ids: [docs.aup, docs.sec, docs.exp] });
    assert.ok((await rules(docs.sec)).every((r) => r.set_id === null));
  });

  test("assigning to everyone puts a targeted member in space mode with its rules cleared, changes nothing on one already there, and never lists a narrowing", async () => {
    const r = await retryOnTeardownRace(() => assignPolicySet(s2, { user_ids: [], group_ids: [], everyone: true }, actor()));
    assert.equal(r.policies, 3);
    assert.deepEqual(r.switched_on, []);
    assert.deepEqual(r.not_narrowed, []);
    assert.ok(r.people >= 4, `every active account (${r.people})`);
    for (const tag of ["sec", "exp"]) {
      assert.equal((await getPolicyAudience(docs[tag]))!.audience_mode, "space", `${tag} is in space mode`);
      assert.deepEqual(await rules(docs[tag]), [], `${tag}: the rules went with it`);
      assert.deepEqual(mine((await openRows(docs[tag])).map((x) => x.user_id)), ["alice", "bob", "carol", "mgr"], `${tag} asks everyone who can see the space`);
    }
    assert.equal((await row(docs.sec, people.bob))!.source, "set", "an open row keeps its source");
    assert.equal((await row(docs.sec, people.mgr))!.source, "space", "a row the widening opened reads 'space'");
    assert.deepEqual(await rules(docs.aup), []);
  });

  test("an unknown set is 404, a target naming nobody is 400, a deactivated set is 409", async () => {
    await assert.rejects(
      assignPolicySet(999_999_999, { user_ids: [people.alice], group_ids: [], everyone: false }, actor()),
      (e: unknown) => e instanceof PolicySetError && e.status === 404 && e.message === SET_NOT_FOUND
    );
    await assert.rejects(
      assignPolicySet(s2, { user_ids: [999_999_999], group_ids: [999_999_998], everyone: false }, actor()),
      (e: unknown) => e instanceof PolicySetError && e.status === 400 && e.message === SET_TARGET_EMPTY
    );
    await updatePolicySet(s2, { active: false });
    await assert.rejects(
      assignPolicySet(s2, { user_ids: [people.alice], group_ids: [], everyone: false }, actor()),
      (e: unknown) => e instanceof PolicySetError && e.status === 409 && e.message === SET_DEACTIVATED
    );
    await updatePolicySet(s2, { active: true });
  });
});

describe("new accounts, deactivation and deletion", () => {
  let s3 = 0;
  let s4 = 0;

  test("a new account lands on an active auto-assign set's policies on day one: a tagged rule names them on a targeted member, source 'set', the new-joiner days; a set with auto-assign off adds nothing", async () => {
    s3 = track(await createPolicySet({ name: `${STAMP} New starter onboarding`, description: "", doc_ids: [docs.coc, docs.handbook], assign_new_members: true }, actor()));
    s4 = track(await createPolicySet({ name: `${STAMP} Optional`, description: "", doc_ids: [docs.notauto], assign_new_members: false }, actor()));
    const erin = await newPerson("erin");
    await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [g3, erin]);
    const enrolled = await retryOnTeardownRace(() => autoAssignPolicies(erin));
    const ids = enrolled.policies.map((p) => p.id);
    assert.ok(ids.includes(docs.coc), "Code of conduct (targeted, G1 only) through the set");
    assert.ok(ids.includes(docs.handbook), "Handbook (space mode, its own new-joiner switch off) through the set");
    assert.ok(!ids.includes(docs.notauto), "the set with auto-assign off adds nothing");
    assert.equal((await row(docs.coc, erin))!.source, "set");
    assert.equal((await row(docs.handbook, erin))!.source, "new_member", "space mode admits the joiner as everyone; no rule is written there");
    assert.equal(await row(docs.notauto, erin), undefined);
    assert.deepEqual(
      (await rules(docs.coc)).filter((r) => r.kind === "user"),
      [{ kind: "user", ref: String(erin), effect: "include", set_id: s3 }],
      "the rule that keeps the row through the hourly sweep, tagged with the set"
    );
    assert.deepEqual((await rules(docs.handbook)), [], "no rule on a space-mode member");
    const due = at((await row(docs.coc, erin))!.due_at);
    assert.ok(due > Date.now() + 13 * DAY && due < Date.now() + 15 * DAY, "the new-joiner days");

    // The My policies rows carry the set and the place in it; the names helper agrees and skips nothing active.
    const rows = await listMyPolicies(erin, asScope([spaceP]));
    const coc = rows.find((r) => r.id === docs.coc)!;
    assert.deepEqual({ names: coc.set_names, position: coc.set_position }, { names: [`${STAMP} New starter onboarding`], position: 0 });
    const handbook = rows.find((r) => r.id === docs.handbook)!;
    assert.deepEqual({ names: handbook.set_names, position: handbook.set_position }, { names: [`${STAMP} New starter onboarding`], position: 1 });
    const names = await policySetNames([docs.aup, docs.sec, docs.exp, docs.travel, docs.coc, docs.notauto]);
    assert.deepEqual(names.get(docs.aup), [`${STAMP} Security basics`]);
    assert.deepEqual(names.get(docs.sec), [`${STAMP} Onboarding`, `${STAMP} Security basics`], "by name");
    assert.deepEqual(names.get(docs.travel), [`${STAMP} Onboarding`]);
    assert.deepEqual(names.get(docs.coc), [`${STAMP} New starter onboarding`]);
    assert.deepEqual(names.get(docs.notauto), [`${STAMP} Optional`], "a set with auto-assign off still names its policies");
    assert.deepEqual(await policySetNames([]), new Map());
  });

  test("the visibility ceiling: a joiner who cannot see a member's private space gets no row through an auto-assign set, and a named person who cannot see it gets none through an assignment", async () => {
    // Outside G3: no group of theirs is granted the fixture space.
    const out = await newPerson("outsider");
    const enrolled = await retryOnTeardownRace(() => autoAssignPolicies(out));
    const ids = enrolled.policies.map((p) => p.id);
    for (const tag of ["coc", "handbook", "notauto"]) {
      assert.ok(!ids.includes(docs[tag]), `${tag}: not enrolled`);
      assert.equal(await row(docs[tag], out), undefined, `${tag}: no row`);
    }
    // The set's rule names them on its targeted member; the ceiling, not the rule, keeps them out.
    assert.ok((await rules(docs.coc)).some((r) => r.kind === "user" && r.ref === String(out) && r.set_id === s3));

    // Named in an assignment of a set whose member is targeted (Optional reading: G1).
    const r = await retryOnTeardownRace(() => assignPolicySet(s4, { user_ids: [out], group_ids: [], everyone: false }, actor()));
    assert.equal(r.policies, 1);
    assert.equal(r.people, 1, "an active account, so counted as named");
    assert.equal(r.added, 0, "nobody was asked");
    assert.equal(await row(docs.notauto, out), undefined);
    assert.ok(!(await requestRows(docs.notauto)).some((q) => (q.user_ids ?? []).includes(out)), "nobody is told");
  });

  test("deactivating stops auto-assign and leaves every row; the name is free while deactivated and must be free again to reactivate", async () => {
    const off = await updatePolicySet(s3, { active: false });
    assert.equal(off!.after.active, 0);
    assert.ok(off!.after.deactivated_at, "stamped");
    const frank = await newPerson("frank");
    await fixtureQuery("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [g3, frank]);
    const enrolled = await retryOnTeardownRace(() => autoAssignPolicies(frank));
    const ids = enrolled.policies.map((p) => p.id);
    assert.ok(!ids.includes(docs.coc), "no rule names frank on Code of conduct");
    assert.ok(!ids.includes(docs.handbook), "Handbook's own new-joiner switch is off and no active set auto-assigns it");
    assert.equal(await row(docs.coc, frank), undefined);
    assert.equal(await row(docs.handbook, frank), undefined);
    assert.equal((await row(docs.coc, people.erin))!.removed_at, null, "erin's row stays open");
    assert.equal((await row(docs.handbook, people.erin))!.removed_at, null);
    assert.equal((await policySetNames([docs.coc])).get(docs.coc), undefined, "a deactivated set names nothing");
    assert.deepEqual((await listMyPolicies(people.erin, asScope([spaceP]))).find((r) => r.id === docs.coc)!.set_names, []);
    const listed = await listPolicySets();
    const active = listed.findIndex((s) => s.id === s4);
    const inactive = listed.findIndex((s) => s.id === s3);
    assert.ok(active >= 0 && inactive > active, "active sets are listed first");

    const twin = track(await createPolicySet({ name: `${STAMP} NEW STARTER onboarding`, description: "", doc_ids: [docs.coc], assign_new_members: false }, actor()));
    await assert.rejects(
      updatePolicySet(s3, { active: true }),
      (e: unknown) => e instanceof PolicySetError && e.status === 409 && e.message === SET_NAME_TAKEN,
      "reactivating under a name taken since"
    );
    assert.equal((await getPolicySet(s3))!.active, 0, "still deactivated");
    assert.deepEqual(await deletePolicySet(twin), { name: `${STAMP} NEW STARTER onboarding`, policies: 1 });
    const on = await updatePolicySet(s3, { active: true });
    assert.equal(on!.after.active, 1);
    assert.equal(on!.after.deactivated_at, null);
    assert.deepEqual((await policySetNames([docs.coc])).get(docs.coc), [`${STAMP} New starter onboarding`]);
  });

  test("deleting a set leaves its rules (untagged) and every row; policies and confirmations stay", async () => {
    // Erin confirms Code of conduct first, so there is a confirmation to keep.
    const v1 = (await listVersions(docs.coc))[0].id;
    assert.equal((await recordAcknowledgement(docs.coc, people.erin, "", v1)).recorded, true);
    assert.equal((await ackSummary(docs.coc)).current, 1);

    assert.deepEqual(await deletePolicySet(s3), { name: `${STAMP} New starter onboarding`, policies: 2 });
    assert.equal(await deletePolicySet(s3), null, "gone");
    assert.equal(await getPolicySet(s3), null);
    assert.equal((await pool().query("SELECT COUNT(*)::int AS n FROM policy_set_docs WHERE set_id = $1", [s3])).rows[0].n, 0);
    assert.deepEqual(
      (await rules(docs.coc)).filter((r) => r.kind === "user"),
      [
        { kind: "user", ref: String(people.erin), effect: "include", set_id: null },
        { kind: "user", ref: String(people.outsider), effect: "include", set_id: null },
      ],
      "the rules keep their place, untagged"
    );
    assert.equal((await row(docs.coc, people.erin))!.source, "set", "the row is as it was");
    assert.equal((await row(docs.coc, people.erin))!.removed_at, null);
    assert.equal((await pool().query("SELECT ack_required FROM documents WHERE id = $1", [docs.coc])).rows[0].ack_required, 1);
    assert.equal((await ackSummary(docs.coc)).current, 1, "erin's confirmation stands");
  });
});

// --- The routes -------------------------------------------------------------------

describe("the routes", () => {
  let list: typeof import("../src/app/api/admin/compliance/sets/route");
  let one: typeof import("../src/app/api/admin/compliance/sets/[id]/route");
  let mgr = "";
  let alice = "";
  let routeSet = 0;

  before(async () => {
    list = await import("../src/app/api/admin/compliance/sets/route");
    one = await import("../src/app/api/admin/compliance/sets/[id]/route");
    mgr = newToken();
    alice = newToken();
    sessions.push(mgr, alice);
    await createSession(mgr, people.mgr, new Date(Date.now() + HOUR).toISOString());
    await createSession(alice, people.alice, new Date(Date.now() + HOUR).toISOString());
  });

  const BASE = "http://localhost/api/admin/compliance/sets";
  const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

  test("GET needs the Compliance section; a manager gets every set and the candidates", async () => {
    const denied = await answer(() => list.GET(), request("GET", BASE, alice));
    assert.equal(denied.status, 403);
    const ok = await answer(() => list.GET(), request("GET", BASE, mgr));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Array.isArray(ok.body.rows) && ok.body.rows.some((s: { name: string }) => s.name === `${STAMP} Onboarding`));
    assert.ok(ok.body.candidates.some((c: { id: number }) => c.id === docs.aup));
    assert.ok(!ok.body.candidates.some((c: { id: number }) => c.id === docs.draft));
  });

  test("POST creates a set, names the first problem with 400, answers 409 for a taken name, and audits ack.set_created", async () => {
    const viewer = await answer(() => list.POST(request("POST", BASE, alice, { name: "x", doc_ids: [docs.aup] })), request("POST", BASE, alice));
    assert.equal(viewer.status, 403);
    for (const [body, error] of [
      [{}, SET_NAME_REQUIRED],
      [{ name: "Route set", doc_ids: [] }, SET_DOCS_RANGE],
      [{ name: "Route set", doc_ids: [docs.draft] }, SET_DOCS_INVALID],
      [{ name: `${STAMP} onboarding`, doc_ids: [docs.aup] }, SET_NAME_TAKEN],
    ] as [unknown, string][]) {
      const r = await answer(() => list.POST(request("POST", BASE, mgr, body)), request("POST", BASE, mgr, body));
      assert.equal(r.status, error === SET_NAME_TAKEN ? 409 : 400, JSON.stringify(r.body));
      assert.deepEqual(r.body, { error });
    }
    const body = { name: `${STAMP} Route set`, description: "From the route", doc_ids: [docs.aup, docs.travel], assign_new_members: false };
    const created = await answer(() => list.POST(request("POST", BASE, mgr, body)), request("POST", BASE, mgr, body));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    routeSet = track(created.body.set);
    assert.deepEqual(created.body.set.docs.map((d: { id: number }) => d.id), [docs.aup, docs.travel]);
    assert.equal(created.body.set.assign_new_members, 0);
    const audited = await auditRows("ack.set_created", routeSet);
    assert.equal(audited.length, 1);
    assert.deepEqual(
      { set: audited[0].details.set, policies: audited[0].details.policies, assign_new_members: audited[0].details.assign_new_members },
      { set: `${STAMP} Route set`, policies: 2, assign_new_members: false }
    );
  });

  test("POST /[id] assigns the set and audits ack.set_assigned; the 400s name the problem; an unknown id is 404", async () => {
    const url = `${BASE}/${routeSet}`;
    for (const [body, error] of [
      [{}, SET_TARGET_EMPTY],
      [{ user_ids: ["a"] }, SET_TARGET_INTEGERS],
    ] as [unknown, string][]) {
      const r = await answer(() => one.POST(request("POST", url, mgr, body), ctx(routeSet)), request("POST", url, mgr, body));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.deepEqual(r.body, { error });
    }
    const missing = await answer(() => one.POST(request("POST", `${BASE}/999999999`, mgr, { group_ids: [g1] }), ctx(999_999_999)), request("POST", url, mgr));
    assert.equal(missing.status, 404);
    const assigned = await answer(
      () => one.POST(request("POST", url, mgr, { group_ids: [g1] }), ctx(routeSet)),
      request("POST", url, mgr, { group_ids: [g1] })
    );
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.ok, true);
    assert.equal(assigned.body.policies, 2);
    assert.equal(assigned.body.people, 1, "alice (G1)");
    assert.deepEqual(assigned.body.not_narrowed, [titles.aup]);
    assert.deepEqual(assigned.body.switched_on, []);
    assert.equal((await row(docs.travel, people.alice))!.source, "set", "Travel (targeted: bob) now asks alice through the set");
    assert.ok((await rules(docs.travel)).some((r) => r.kind === "group" && r.ref === String(g1) && r.set_id === routeSet));
    const audited = await auditRows("ack.set_assigned", routeSet);
    assert.equal(audited.length, 1);
    assert.deepEqual(
      { set: audited[0].details.set, people: audited[0].details.people, policies: audited[0].details.policies, switched_on: audited[0].details.switched_on, group_ids: audited[0].details.group_ids },
      { set: `${STAMP} Route set`, people: 1, policies: 2, switched_on: [], group_ids: [g1] }
    );
  });

  test("PATCH edits or deactivates with its own audit key; DELETE removes the set and audits; both answer 404 afterwards", async () => {
    const url = `${BASE}/${routeSet}`;
    const empty = await answer(() => one.PATCH(request("PATCH", url, mgr, {}), ctx(routeSet)), request("PATCH", url, mgr, {}));
    assert.deepEqual([empty.status, empty.body], [400, { error: SET_NOTHING_TO_CHANGE }]);
    const renamed = await answer(
      () => one.PATCH(request("PATCH", url, mgr, { name: `${STAMP} Route set 2` }), ctx(routeSet)),
      request("PATCH", url, mgr)
    );
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.set.name, `${STAMP} Route set 2`);
    const updated = await auditRows("ack.set_updated", routeSet);
    assert.equal(updated.length, 1);
    assert.deepEqual(updated[0].details.changed, ["name"]);
    assert.equal(updated[0].details.renamed_from, `${STAMP} Route set`);
    const off = await answer(() => one.PATCH(request("PATCH", url, mgr, { active: false }), ctx(routeSet)), request("PATCH", url, mgr));
    assert.equal(off.status, 200);
    assert.equal(off.body.set.active, 0);
    assert.equal((await auditRows("ack.set_deactivated", routeSet)).length, 1);
    assert.equal((await auditRows("ack.set_updated", routeSet)).length, 1, "deactivating is its own key");
    const missing = await answer(() => one.PATCH(request("PATCH", `${BASE}/999999999`, mgr, { active: true }), ctx(999_999_999)), request("PATCH", url, mgr));
    assert.deepEqual([missing.status, missing.body], [404, { error: SET_NOT_FOUND }]);

    const viewer = await answer(() => one.DELETE(request("DELETE", url, alice), ctx(routeSet)), request("DELETE", url, alice));
    assert.equal(viewer.status, 403);
    const gone = await answer(() => one.DELETE(request("DELETE", url, mgr), ctx(routeSet)), request("DELETE", url, mgr));
    assert.deepEqual([gone.status, gone.body], [200, { ok: true }]);
    assert.equal((await auditRows("ack.set_deleted", routeSet)).length, 1);
    const again = await answer(() => one.DELETE(request("DELETE", url, mgr), ctx(routeSet)), request("DELETE", url, mgr));
    assert.equal(again.status, 404);
    assert.ok((await rules(docs.travel)).some((r) => r.kind === "group" && r.ref === String(g1) && r.set_id === null), "the rule stays, untagged");
    assert.equal((await row(docs.travel, people.alice))!.removed_at, null, "the row stays");
  });
});

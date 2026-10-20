// Who must confirm (D1, 1.13.0): a policy asks the people on its
// policy_assignments rows, materialised from its audience by
// reconcilePolicyAssignments. Space mode is what every policy did before
// (everyone active who can see the space); targeted mode names groups,
// people and ladder roles, minus exclusions; every target is intersected
// with the visibility ceiling, so a rule reaches nobody who would 404. Rows
// are never deleted: a person who leaves keeps a closed row with the reason
// and the same row re-opens when they return, exemption history and all; a
// disabled account's rows close and re-open on the status flip; closing a
// row never touches the acknowledgements ledger; a person with no open row
// cannot confirm (POST /ack answers 400); a new account is enrolled with
// one welcome notice; and the one-shot migration gives a 1.12.0 database
// the same counts it had.
//
// The route handler is called directly, the way test/ack-statement.test.ts
// does it: next/headers resolves to a stub that serves the request under
// test, and lib/ee to a stub that grants policy_ack.
//
// Five test files share the database. Counts over an internal space include
// every account the other files are inserting, so the assertions here name
// this file's own people (membership, never a bare total) and use a private
// space when a whole set must be known.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-audience.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  listVersions,
  recordAcknowledgement,
  getCurrentAck,
  ackStatusForDocument,
  ackSummary,
  compliancePendingUsers,
  complianceUserSummary,
  listMyPolicies,
  countPendingAcksFor,
  hasPolicyInScope,
  hasOpenAssignment,
  createGroup,
  addGroupMember,
  removeGroupMember,
  setGroupMembers,
  setSpaceGroups,
  createUser,
  updateUser,
  createSession,
  saveAudienceRules,
  listAudienceRules,
  getPolicyAudience,
  previewAudience,
  reconcilePolicyAssignments,
  reconcileAllPolicies,
  autoAssignPolicies,
  listOwedPoliciesFor,
  drainAudienceSyncTally,
  migratePolicyAssignments,
} from "../src/lib/db";
import { asScope } from "../src/lib/space-scope";
import { hashPassword, newToken } from "../src/lib/password";
import { sanitizeRules, audienceSavedToast } from "../src/lib/audience";
import { deliverAckNotices, notifyWelcome, noticeCopy } from "../src/lib/compliance";
import type { Mailer } from "../src/lib/compliance";
import { audienceReportLine } from "../src/lib/directory-schedule";
import { fixtureQuery } from "./support/retry";
import { assignEveryone } from "./support/assign";

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-audience.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-audience.virtual.js");
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

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, req: Request, id: number): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await handler(req, { params: Promise.resolve({ id: String(id) }) });
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

function sessionRequest(url: string, session: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.31" },
    body: JSON.stringify(body),
  });
}

// --- Fixtures -------------------------------------------------------------------

const STAMP = `ackaud-${Date.now()}`;

let spaceA = 0; // internal
let spaceP = 0; // private, granted to group G1
let spaceW = 0; // internal, the welcome and migration fixtures
let g1 = 0;
let g2 = 0;
// The two private-space policies (space mode, then targeted): the ceiling
// assertions on the account hooks name them.
let closedId = 0;
let ceilingId = 0;
const people: Record<string, number> = {};
const userIds: number[] = [];
const docIds: number[] = [];
const sessions: string[] = [];

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newPerson(tag: string, role = "viewer"): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `${tag[0].toUpperCase()}${tag.slice(1)} ${STAMP}`, `${STAMP}-${tag}@example.test`, role]
  );
  people[tag] = r.rows[0].id;
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newPolicy(title: string, space = spaceA, author = "test"): Promise<{ id: number; title: string; v1: number }> {
  const full = `${STAMP} ${title}`;
  const doc = await createDocument({
    space_id: space,
    title: full,
    type: "policy",
    status: "published",
    content: LONG_TEXT,
    summary: "",
    tags: [],
    author,
  });
  // editDefault / recertMonths null: never read the shared workspace setting.
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  docIds.push(doc.id);
  return { id: doc.id, title: full, v1: (await listVersions(doc.id))[0].id };
}

/** This file's people among a roster, as tags, sorted. */
function mine(ids: number[]): string[] {
  const byId = new Map(Object.entries(people).map(([tag, id]) => [id, tag]));
  return ids
    .map((id) => byId.get(id))
    .filter((t): t is string => Boolean(t))
    .sort();
}

async function row(docId: number, userId: number) {
  const r = await pool().query(
    `SELECT id, source, removed_at, removed_reason, exempt_at, exempt_reason, cycle_started_at, due_at, reminded_at, escalated_at
     FROM policy_assignments WHERE document_id = $1 AND user_id = $2`,
    [docId, userId]
  );
  // Timestamps come back as ISO text (lib/db's type parsers), so they are compared through Date.parse.
  return r.rows[0] as
    | {
        id: number;
        source: string;
        removed_at: string | null;
        removed_reason: string;
        exempt_at: string | null;
        exempt_reason: string;
        cycle_started_at: string;
        due_at: string | null;
        reminded_at: string | null;
        escalated_at: string | null;
      }
    | undefined;
}

/** The open 'request' outbox rows a save queued for a policy (the people it added), oldest first. */
async function requestRows(docId: number): Promise<{ id: number; user_ids: number[]; source: string }[]> {
  const r = await pool().query(
    "SELECT id, user_ids, source FROM ack_outbox WHERE document_id = $1 AND mode = 'request' AND done_at IS NULL ORDER BY id",
    [docId]
  );
  return r.rows;
}

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

async function ledgerCount(docId: number): Promise<number> {
  return (await pool().query("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [docId])).rows[0].n;
}

/** The document marker (ack_revision_at), as ISO text. */
async function marker(docId: number): Promise<string> {
  return (await pool().query("SELECT ack_revision_at FROM documents WHERE id = $1", [docId])).rows[0].ack_revision_at;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const spaces = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES
       ($1, $2, '📁', '', 'internal'), ($3, $4, '📁', '', 'private'), ($5, $6, '📁', '', 'internal')
     RETURNING id`,
    [`Audience A ${STAMP}`, `${STAMP}-a`, `Audience P ${STAMP}`, `${STAMP}-p`, `Audience W ${STAMP}`, `${STAMP}-w`]
  );
  [spaceA, spaceP, spaceW] = spaces.rows.map((r: { id: number }) => r.id);
  for (const tag of ["alice", "bob", "carol", "erin", "frank"]) await newPerson(tag);
  await newPerson("dave", "approver");
  g1 = (await createGroup({ name: `${STAMP} G1` })).id;
  g2 = (await createGroup({ name: `${STAMP} G2` })).id;
  await addGroupMember(g1, people.alice);
  await addGroupMember(g2, people.bob);
  await setSpaceGroups(spaceP, [g1]);
});

after(async () => {
  // Only what this file made.
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  // A welcome row is keyed to the joiner's earliest-due policy, which may be another file's: by person too.
  for (const id of userIds) await pool().query("DELETE FROM ack_outbox WHERE user_ids @> $1::jsonb", [JSON.stringify([id])]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query(
    "DELETE FROM audit_log WHERE (action LIKE 'ack.%' OR action LIKE 'document.ack%') AND (target_id = ANY($1) OR target_id = ANY($2))",
    [docIds.map(String), userIds.map(String)]
  );
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM groups WHERE id = ANY($1)", [[g1, g2]]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[spaceA, spaceP, spaceW]]);
});

describe("sanitizeRules", () => {
  test("keeps known kinds with usable refs, defaults the effect, dedupes and caps; anything else is dropped", () => {
    const out = sanitizeRules([
      { kind: "group", ref: 12 },
      { kind: "group", ref: "12", effect: "include" },
      { kind: "user", ref: "7", effect: "exclude" },
      { kind: "role", ref: " Approver " },
      { kind: "role", ref: "owner" },
      { kind: "team", ref: "1" },
      { kind: "user", ref: "abc" },
      { kind: "user", ref: -3 },
      { kind: "group", ref: "4", effect: "maybe" },
      null,
      "group",
    ]);
    assert.deepEqual(out, [
      { kind: "group", ref: "12", effect: "include" },
      { kind: "user", ref: "7", effect: "exclude" },
      { kind: "role", ref: "approver", effect: "include" },
    ]);
    assert.deepEqual(sanitizeRules("nope"), []);
    assert.deepEqual(sanitizeRules(undefined), []);
    assert.equal(sanitizeRules(Array.from({ length: 300 }, (_, i) => ({ kind: "user", ref: i + 1 }))).length, 200);
  });

  test("the toast and the report line read in the glossary's words", () => {
    assert.equal(audienceSavedToast({ added: 14, closed: 3, reopened: 0 }), "Audience saved: 14 people added, 3 people removed from the audience");
    assert.equal(audienceSavedToast({ added: 0, closed: 1, reopened: 1 }), "Audience saved: 1 person added, 1 person removed from the audience");
    assert.equal(audienceSavedToast({ added: 0, closed: 0, reopened: 0 }), "Audience saved. Nobody was added or removed.");
    assert.equal(audienceReportLine({ added: 12, closed: 3 }), "Policy audiences updated: +12 / −3");
    assert.equal(audienceReportLine({ added: 0, closed: 0 }), "");
    assert.equal(audienceReportLine(null), "");
  });
});

describe("space mode: the old rule, as rows", () => {
  test("switching a policy on writes one open row per active person who can see the space, and every reader agrees with it", async () => {
    const open = await newPolicy("space internal");
    const roster = await ackStatusForDocument(open.id);
    assert.deepEqual(mine(roster.map((r) => r.id)), ["alice", "bob", "carol", "dave", "erin", "frank"], "an internal space: everyone active");
    assert.ok(roster.every((r) => r.assignment_id != null && !r.exempt), "each row carries its assignment and is not exempt");
    const audience = await getPolicyAudience(open.id);
    assert.deepEqual(audience, { audience_mode: "space", rules: [], exclude_stewards: false, assign_new_members: true });
    for (const tag of ["alice", "bob"]) assert.equal(await hasOpenAssignment(open.id, people[tag]), true);
    assert.deepEqual(mine((await compliancePendingUsers(open.id)).map((u) => u.id)), ["alice", "bob", "carol", "dave", "erin", "frank"]);
    const sum = await ackSummary(open.id);
    assert.ok(sum.eligible >= 6, `the summary counts the rows (${sum.eligible})`);
    assert.equal(sum.current, 0);
    assert.equal(await hasPolicyInScope(people.alice, asScope([spaceA])), true);
    assert.equal(await countPendingAcksFor(people.alice, asScope([spaceA])), 1);
    assert.equal((await listMyPolicies(people.alice, asScope([spaceA])))[0].state, "pending");

    // A private space: only the people its grants reach (G1 = alice).
    const closed = await newPolicy("space private", spaceP);
    closedId = closed.id;
    const named = mine((await ackStatusForDocument(closed.id)).map((r) => r.id));
    assert.deepEqual(named, ["alice"], "a private space: the granted group's members");
    assert.equal(await hasOpenAssignment(closed.id, people.bob), false);
    assert.equal(await hasPolicyInScope(people.bob, asScope([spaceP])), false, "no row, no nav item");
    assert.equal(await countPendingAcksFor(people.carol, asScope([spaceP])), 0);
    const perUser = await complianceUserSummary();
    assert.equal(perUser.find((u) => u.id === people.alice)!.required, 2, "alice owes both");
    assert.equal(perUser.find((u) => u.id === people.bob)!.required, 1, "bob owes the internal one only");

    // Reconciling again moves nothing.
    assert.deepEqual(await reconcilePolicyAssignments(null, open.id), { added: 0, closed: 0, reopened: 0 });
    assert.deepEqual(await assignEveryone(closed.id), { added: 0, closed: 0, reopened: 0 });
  });

  test("a confirmation counts from the later of the marker and the row's cycle, so the roster, the summary and the reader agree", async () => {
    const { id, v1 } = await newPolicy("space currency");
    await recordAcknowledgement(id, people.alice, "", v1);
    assert.ok(await getCurrentAck(id, people.alice));
    assert.equal((await ackSummary(id)).current, 1);
    assert.equal((await listMyPolicies(people.alice, asScope([spaceA]))).find((r) => r.id === id)!.state, "confirmed");
    // The row's own cycle moves (what a per-person re-ask or a return does): the same confirmation no longer counts.
    await pool().query("UPDATE policy_assignments SET cycle_started_at = now() WHERE document_id = $1 AND user_id = $2", [id, people.alice]);
    assert.equal(await getCurrentAck(id, people.alice), undefined, "the reader's card asks again");
    assert.equal((await ackSummary(id)).current, 0, "the summary agrees");
    assert.equal((await ackStatusForDocument(id)).find((r) => r.id === people.alice)!.acknowledged_at, null, "the roster agrees");
    assert.equal((await listMyPolicies(people.alice, asScope([spaceA]))).find((r) => r.id === id)!.state, "reconfirm");
    assert.ok((await compliancePendingUsers(id)).some((u) => u.id === people.alice), "and the notices reach them again");
  });
});

describe("targeted mode: rules, exclusions and the ceiling", () => {
  test("a group rule hits its members and misses everyone else; a named person is added; an exclude rule closes a row with 'audience_narrowed'; the preview says what a save would do", async () => {
    const { id } = await newPolicy("targeted");
    const preview = await previewAudience(id, {
      audience_mode: "targeted",
      rules: sanitizeRules([{ kind: "group", ref: g1 }, { kind: "user", ref: people.carol }]),
      exclude_stewards: false,
    });
    assert.equal(preview.count, 2, "alice (G1) and carol (named)");
    assert.equal(preview.no_access, 0);
    assert.deepEqual(preview.sample, [`Alice ${STAMP}`, `Carol ${STAMP}`]);

    const before = await ledgerCount(id);
    const saved = await saveAudienceRules(id, {
      audience_mode: "targeted",
      rules: sanitizeRules([{ kind: "group", ref: g1 }, { kind: "user", ref: people.carol }]),
    });
    assert.ok(saved);
    assert.equal(saved!.audience_mode, "targeted");
    assert.equal(saved!.added, 0, "alice and carol already had open rows from the switch-on");
    assert.ok(saved!.closed >= 4, `everyone else is closed (${saved!.closed})`);
    assert.deepEqual(mine((await ackStatusForDocument(id)).map((r) => r.id)), ["alice", "carol"]);
    assert.equal((await row(id, people.alice))!.source, "space", "an open row keeps its source");
    assert.deepEqual(await requestRows(id), [], "a save that adds nobody tells nobody");
    const bob = (await row(id, people.bob))!;
    assert.ok(bob.removed_at, "bob's row is closed, not deleted");
    assert.equal(bob.removed_reason, "audience_narrowed");
    assert.equal(await hasOpenAssignment(id, people.bob), false);
    assert.equal(await hasPolicyInScope(people.bob, asScope([spaceA])), true, "bob is still asked by the other policies in the space");
    assert.deepEqual(await listAudienceRules(id), [
      { kind: "group", ref: String(g1), effect: "include" },
      { kind: "user", ref: String(people.carol), effect: "include" },
    ]);

    // Excluding carol closes her row and names why; the rules are replaced whole.
    const narrowed = await saveAudienceRules(id, {
      rules: sanitizeRules([{ kind: "group", ref: g1 }, { kind: "user", ref: people.carol }, { kind: "user", ref: people.carol, effect: "exclude" }]),
    });
    assert.deepEqual({ added: narrowed!.added, closed: narrowed!.closed, reopened: narrowed!.reopened }, { added: 0, closed: 1, reopened: 0 });
    assert.equal((await row(id, people.carol))!.removed_reason, "audience_narrowed");
    assert.deepEqual(mine((await ackStatusForDocument(id)).map((r) => r.id)), ["alice"]);
    assert.equal(await ledgerCount(id), before, "closing rows never touches the ledger");

    // Back to space mode: the closed rows re-open (the same rows), with a
    // fresh cycle; the rules go with the mode (space mode means everyone,
    // so no stored exclusion keeps carol out) although the save sent none;
    // and the people the save re-opened are told, in one request row
    // limited to them (alice, who stayed open, is not on it).
    const widened = await saveAudienceRules(id, { audience_mode: "space" });
    assert.equal(widened!.added, 0);
    assert.ok(widened!.reopened >= 5, `the closed rows re-open (${widened!.reopened})`);
    assert.deepEqual(widened!.rules, [], "the answer carries no rules");
    assert.deepEqual(await listAudienceRules(id), [], "space mode cleared the stored rules, the exclusion included");
    assert.equal((await row(id, people.bob))!.id, bob.id, "the same row, re-opened");
    assert.equal((await row(id, people.bob))!.removed_at, null);
    assert.equal((await row(id, people.bob))!.removed_reason, "");
    assert.equal(await hasOpenAssignment(id, people.carol), true, "carol is back: the exclusion is gone with the rules");
    const told = await requestRows(id);
    assert.equal(told.length, 1, "one request row for the people the save re-opened");
    assert.equal(told[0].source, "manual");
    assert.equal(told[0].user_ids.length, widened!.reopened, "limited to them");
    assert.ok(told[0].user_ids.includes(people.bob) && told[0].user_ids.includes(people.carol));
    assert.ok(!told[0].user_ids.includes(people.alice), "alice stayed open and is not told again");
    await pool().query("DELETE FROM ack_outbox WHERE id = $1", [told[0].id]);

    // An exclude rule is a targeted-mode rule: in space mode (a hand-written
    // row, or the preview of a draft) it keeps nobody out.
    const spaceWide = await previewAudience(id, { audience_mode: "space", rules: [], exclude_stewards: false });
    const spaceWithExclude = await previewAudience(id, {
      audience_mode: "space",
      rules: sanitizeRules([{ kind: "user", ref: people.carol, effect: "exclude" }]),
      exclude_stewards: false,
    });
    assert.equal(spaceWithExclude.count, spaceWide.count, "an exclude rule is ignored in space mode");
    const targetedWithExclude = await previewAudience(id, {
      audience_mode: "targeted",
      rules: sanitizeRules([{ kind: "group", ref: g1 }, { kind: "user", ref: people.carol }, { kind: "user", ref: people.carol, effect: "exclude" }]),
      exclude_stewards: false,
    });
    assert.equal(targetedWithExclude.count, 1, "and applied in targeted mode (alice only)");
  });

  test("a save tells the people it adds: one 'request' row limited to them, none when nobody was added", async () => {
    const { id } = await newPolicy("told");
    const narrowed = await saveAudienceRules(id, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "user", ref: people.alice }]) });
    assert.equal(narrowed!.added + narrowed!.reopened, 0);
    assert.deepEqual(await requestRows(id), [], "nothing added, nobody told");
    const widened = await saveAudienceRules(id, {
      rules: sanitizeRules([{ kind: "user", ref: people.alice }, { kind: "user", ref: people.carol }]),
    });
    assert.deepEqual({ added: widened!.added, reopened: widened!.reopened }, { added: 0, reopened: 1 }, "carol's closed row re-opens");
    const told = await requestRows(id);
    assert.equal(told.length, 1);
    assert.deepEqual(told[0].user_ids, [people.carol], "carol alone: alice was asked already");
    await pool().query("DELETE FROM ack_outbox WHERE id = $1", [told[0].id]);
    // The same rules again: nothing moves, nothing is queued.
    const same = await saveAudienceRules(id, {
      rules: sanitizeRules([{ kind: "user", ref: people.alice }, { kind: "user", ref: people.carol }]),
    });
    assert.equal(same!.added + same!.reopened, 0);
    assert.deepEqual(await requestRows(id), []);
  });

  test("a person a rule names who cannot see the space is not enrolled and counts as 'no access' in the preview; a grant brings them in through the space hook", async () => {
    const { id } = await newPolicy("ceiling", spaceP);
    ceilingId = id;
    const rules = sanitizeRules([{ kind: "user", ref: people.bob }, { kind: "role", ref: "approver" }]);
    const preview = await previewAudience(id, { audience_mode: "targeted", rules, exclude_stewards: false });
    assert.equal(preview.count, 0, "neither bob nor dave can see the private space");
    assert.equal(preview.no_access, 2, "both are named and shown as No access");
    assert.deepEqual(preview.sample, []);
    const saved = await saveAudienceRules(id, { audience_mode: "targeted", rules });
    assert.equal(saved!.added, 0, "a rule narrows and never widens");
    assert.equal(await hasOpenAssignment(id, people.bob), false);
    assert.equal(await hasOpenAssignment(id, people.alice), false, "alice sees the space but no rule names her");
    assert.equal((await row(id, people.alice))!.removed_reason, "audience_narrowed");

    // Granting bob's group to the space (the space.member writer) enrols him; dave still cannot see it.
    await setSpaceGroups(spaceP, [g1, g2]);
    assert.equal(await hasOpenAssignment(id, people.bob), true, "the grant writer reconciled the space's policies");
    assert.equal((await row(id, people.bob))!.source, "user");
    assert.equal(await hasOpenAssignment(id, people.dave), false);
    assert.equal((await previewAudience(id, { audience_mode: "targeted", rules, exclude_stewards: false })).no_access, 1);
    // And taking the grant away closes the row with 'access_removed'.
    await setSpaceGroups(spaceP, [g1]);
    assert.equal((await row(id, people.bob))!.removed_reason, "access_removed");
  });

  test("'Exempt the document's author and approvers' takes the author and the approvers out, by name and by role", async () => {
    const { id } = await newPolicy("stewards", spaceA, `Erin ${STAMP}`);
    assert.deepEqual(mine((await ackStatusForDocument(id)).map((r) => r.id)), ["alice", "bob", "carol", "dave", "erin", "frank"]);
    const preview = await previewAudience(id, { audience_mode: "space", rules: [], exclude_stewards: true });
    assert.ok(preview.count >= 4);
    assert.equal(preview.no_access, 0, "never counted in space mode");
    const saved = await saveAudienceRules(id, { exclude_stewards: true });
    assert.equal(saved!.exclude_stewards, true);
    const after = mine((await ackStatusForDocument(id)).map((r) => r.id));
    assert.ok(!after.includes("erin"), "the author (the byline) is out");
    assert.ok(!after.includes("dave"), "an approver is out");
    assert.ok(after.includes("alice") && after.includes("bob") && after.includes("carol") && after.includes("frank"), "readers stay");
    assert.equal((await row(id, people.erin))!.removed_reason, "audience_narrowed");
  });
});

describe("people who leave and come back", () => {
  test("leaving a group closes the row with 'left_group' and rejoining re-opens the same row, exemption history kept, with a fresh cycle and deadline and the reminder and escalation stamps cleared", async () => {
    const { id } = await newPolicy("rejoin");
    await saveAudienceRules(id, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "group", ref: g1 }]) });
    const first = (await row(id, people.alice))!;
    assert.equal(first.source, "space", "the row from the switch-on stays, and keeps its source");
    // What an exemption writes on the row (D2), by hand here so this file
    // does not depend on that path; and the stamps the sweeps leave (E2) on
    // a row that was reminded and escalated in the old cycle.
    await pool().query(
      `UPDATE policy_assignments
       SET exempt_at = now(), exempt_reason = 'On leave', exempt_by_name = 'Manager',
           reminded_at = now() - interval '2 days', escalated_at = now() - interval '1 day', reminder_count = 2
       WHERE id = $1`,
      [first.id]
    );
    assert.equal(await hasOpenAssignment(id, people.alice), false, "an exempt row is not open");
    const before = await ledgerCount(id);

    await removeGroupMember(g1, people.alice);
    const gone = (await row(id, people.alice))!;
    assert.equal(gone.id, first.id);
    assert.ok(gone.removed_at, "closed");
    assert.equal(gone.removed_reason, "left_group");
    assert.ok(gone.exempt_at, "the exemption is history on the closed row");

    await addGroupMember(g1, people.alice);
    const back = (await row(id, people.alice))!;
    assert.equal(back.id, first.id, "the same row re-opens");
    assert.equal(back.removed_at, null);
    assert.equal(back.removed_reason, "");
    assert.equal(back.source, "group", "admitted by the group rule now");
    assert.equal(back.exempt_reason, "On leave", "the exemption history survives");
    assert.ok(back.exempt_at, "and the person is still excused (the roster shows Exempt)");
    assert.ok(at(back.cycle_started_at) > at(first.cycle_started_at), "a fresh cycle");
    assert.ok(at(back.due_at) > Date.now() + 13 * 86_400_000, "a fresh deadline from the cascade (the new-joiner days, 14 built in)");
    assert.equal(back.reminded_at, null, "the old cycle's reminder stamp is cleared: the new cycle is reminded on its own");
    assert.equal(back.escalated_at, null, "and its escalation stamp, so a late return is escalated again");
    assert.equal(
      (await pool().query("SELECT reminder_count FROM policy_assignments WHERE id = $1", [first.id])).rows[0].reminder_count,
      2,
      "the reminder history stays"
    );
    assert.equal(await ledgerCount(id), before, "the ledger is untouched");

    // The sync path (setGroupMembers) reconciles too and tallies for the report.
    drainAudienceSyncTally();
    await setGroupMembers(g1, [people.alice, people.carol]);
    assert.equal(await hasOpenAssignment(id, people.carol), true, "carol joined the group and the policy");
    const tally = drainAudienceSyncTally();
    assert.ok(tally.added >= 1, `the report counts the add (${JSON.stringify(tally)})`);
    assert.deepEqual(drainAudienceSyncTally(), { added: 0, closed: 0 }, "a drain resets it");
    await setGroupMembers(g1, [people.alice]);
    assert.equal((await row(id, people.carol))!.removed_reason, "left_group");
    assert.ok(drainAudienceSyncTally().closed >= 1);
  });

  test("a disabled account's rows close with 'disabled' and re-open on re-enable, asked afresh; a confirmation from before no longer counts", async () => {
    const { id, v1 } = await newPolicy("status flip");
    await recordAcknowledgement(id, people.frank, "", v1);
    const first = (await row(id, people.frank))!;
    await updateUser(people.frank, { status: "disabled" });
    const off = (await row(id, people.frank))!;
    assert.equal(off.id, first.id);
    assert.ok(off.removed_at);
    assert.equal(off.removed_reason, "disabled");
    assert.ok(!(await compliancePendingUsers(id)).some((u) => u.id === people.frank));
    assert.ok(!(await ackStatusForDocument(id)).some((r) => r.id === people.frank), "off the roster");

    await updateUser(people.frank, { status: "active" });
    const on = (await row(id, people.frank))!;
    assert.equal(on.id, first.id, "the same row");
    assert.equal(on.removed_at, null);
    assert.ok(at(on.cycle_started_at) > at(first.cycle_started_at), "a fresh cycle");
    assert.ok(at(on.due_at) > Date.now(), "a fresh deadline, never a past date");
    assert.equal(await getCurrentAck(id, people.frank), undefined, "the earlier confirmation does not count for the new cycle");
    assert.equal((await listMyPolicies(people.frank, asScope([spaceA]))).find((r) => r.id === id)!.state, "reconfirm");
    assert.ok((await compliancePendingUsers(id)).some((u) => u.id === people.frank));
    // The ceiling on the status hook: frank cannot see the private space, so
    // re-enabling him opens nothing there (invariant 2).
    assert.equal(await hasOpenAssignment(closedId, people.frank), false, "no row on the private space's policy");
    assert.equal(await hasOpenAssignment(ceilingId, people.frank), false);
    assert.equal(await row(closedId, people.frank), undefined, "not even a closed one");
  });
});

describe("the ack route", () => {
  test("POST /ack answers 400 for a person the policy does not ask, and records for one it does", async () => {
    const { id, v1 } = await newPolicy("route");
    await saveAudienceRules(id, { audience_mode: "targeted", rules: sanitizeRules([{ kind: "user", ref: people.alice }]) });
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    const forAlice = newToken();
    const forBob = newToken();
    await createSession(forAlice, people.alice, expires);
    await createSession(forBob, people.bob, expires);
    sessions.push(forAlice, forBob);
    const ack = await import("../src/app/api/documents/[id]/ack/route");
    const url = `http://localhost/api/documents/${id}/ack`;

    const refused = await call(ack.POST as Handler, sessionRequest(url, forBob, { version_id: v1 }), id);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "This document doesn't ask you for a read confirmation.");
    assert.equal(await ledgerCount(id), 0, "nothing was written");

    const ok = await call(ack.POST as Handler, sessionRequest(url, forAlice, { version_id: v1 }), id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    assert.equal(await ledgerCount(id), 1);
  });
});

describe("new accounts and the welcome notice", () => {
  test("a new account is enrolled in every policy that admits it and enrols new joiners, with one welcome notice listing them; a single policy goes as a request", async () => {
    const w1 = await newPolicy("welcome 1", spaceW);
    const w2 = await newPolicy("welcome 2", spaceW);
    const w3 = await newPolicy("welcome off", spaceW);
    await saveAudienceRules(w3.id, { assign_new_members: false });
    const { hash, salt } = hashPassword("Newbie!12345");
    const newbie = await createUser({
      username: `${STAMP}-newbie`,
      name: `Newbie ${STAMP}`,
      email: `${STAMP}-newbie@example.test`,
      role: "viewer",
      passwordHash: hash,
      passwordSalt: salt,
    });
    userIds.push(newbie.id);
    people.newbie = newbie.id;

    assert.equal(await hasOpenAssignment(w1.id, newbie.id), true);
    assert.equal(await hasOpenAssignment(w2.id, newbie.id), true);
    assert.equal(await hasOpenAssignment(w3.id, newbie.id), false, "'Enrol new joiners automatically' is off");
    const r1 = (await row(w1.id, newbie.id))!;
    assert.equal(r1.source, "new_member");
    assert.ok(at(r1.due_at) > Date.now() + 13 * 86_400_000, "due the new-joiner days from now");
    assert.equal(at(r1.cycle_started_at), at(await marker(w1.id)), "a fresh row's cycle is the policy's (the marker), not the enrolment");
    // The ceiling on the account hook (invariant 2): a viewer with no grant
    // cannot see the private space, so the hook opens nothing on its two
    // policies and the welcome does not name them.
    assert.equal(await hasOpenAssignment(closedId, newbie.id), false, "a private space the joiner cannot see");
    assert.equal(await hasOpenAssignment(ceilingId, newbie.id), false);
    assert.equal(await row(closedId, newbie.id), undefined, "no row at all, open or closed");
    const owed = await listOwedPoliciesFor(newbie.id);
    assert.ok(owed.some((p) => p.id === w1.id) && owed.some((p) => p.id === w2.id) && !owed.some((p) => p.id === w3.id));
    assert.ok(owed.every((p) => ![closedId, ceilingId].includes(p.id)), "the welcome's list keeps to what they can see");
    assert.ok(owed.length >= 2);

    const enrolled = (
      await pool().query("SELECT details FROM audit_log WHERE action = 'ack.auto_enrolled' AND target_id = $1 ORDER BY id DESC LIMIT 1", [
        String(newbie.id),
      ])
    ).rows[0];
    assert.ok(enrolled, "ack.auto_enrolled was written");
    assert.equal(enrolled.details.user_id, newbie.id);
    assert.ok((enrolled.details.policies as number[]).includes(w1.id) && (enrolled.details.policies as number[]).includes(w2.id));

    const queued = (
      await pool().query("SELECT id, document_id, mode, user_ids FROM ack_outbox WHERE mode = 'welcome' AND user_ids @> $1::jsonb AND done_at IS NULL", [
        JSON.stringify([newbie.id]),
      ])
    ).rows;
    assert.equal(queued.length, 1, "one welcome row");
    assert.deepEqual(queued[0].user_ids, [newbie.id]);
    // Keyed to the first policy the hook opened (earliest due, then title),
    // which the drain only uses to find the row: the list is resolved again
    // at delivery. Among equal due dates the hook and listOwedPoliciesFor
    // break the tie by title under different collations (JS and the
    // database's), so the key is pinned as one of the policies owed, which
    // may be another file's (the after() hook deletes the row by person).
    assert.ok(owed.some((p) => p.id === queued[0].document_id), "keyed to one of the policies they owe");

    // Deliver it: one email naming every policy owed, one inbox line, one record row per policy.
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const mailer: Mailer = async (to, subject, text) => {
      sent.push({ to, subject, text });
    };
    await pool().query("UPDATE ack_outbox SET not_before = now() WHERE id = $1", [queued[0].id]);
    const out = await deliverAckNotices({ documentIds: [queued[0].document_id], mailer, origin: "https://docs.example.test" });
    assert.equal(out.delivered, 1, JSON.stringify(out));
    assert.equal(sent.length, 1, "one mail, not one per policy");
    assert.deepEqual(sent[0].to, [`${STAMP}-newbie@example.test`]);
    assert.match(sent[0].subject, new RegExp(`Welcome: ${owed.length} policies to read`));
    assert.ok(sent[0].text.includes(w1.title) && sent[0].text.includes(w2.title), "the list names the policies");
    assert.ok(!sent[0].text.includes(w3.title));
    assert.match(sent[0].text, /\(due [A-Za-z0-9][^)]*\)/, `with their due dates, formatted the workspace's way:\n${sent[0].text}`);
    assert.ok(sent[0].text.includes("https://docs.example.test/compliance"), "linking My policies");
    const notices = (
      await pool().query("SELECT document_id, kind, channels FROM ack_notices WHERE outbox_id = $1 AND user_id = $2 ORDER BY document_id", [
        queued[0].id,
        newbie.id,
      ])
    ).rows;
    assert.equal(notices.length, owed.length, "one record row per policy named");
    assert.ok(notices.every((n) => n.kind === "welcome" && n.channels.includes("inapp") && n.channels.includes("email")));
    const inbox = (await pool().query("SELECT title, link FROM notifications WHERE user_id = $1 AND kind = 'ack_requested'", [newbie.id])).rows;
    assert.equal(inbox.length, 1, "one inbox line");
    assert.equal(inbox[0].link, "/compliance");
    assert.match(inbox[0].title, /^Welcome: \d+ policies to read$/);
    const copy = noticeCopy({ mode: "welcome", docTitle: "", actorName: "", count: 5, titles: ["A", "B", "C", "D", "E"] });
    assert.equal(copy.title, "Welcome: 5 policies to read");
    assert.equal(copy.body, 'Please read and confirm "A", "B", "C" and 2 more. Each one shows its due date on My policies.');

    // One policy: the usual request for that person alone.
    const single = await notifyWelcome(newbie.id, [{ id: w1.id }]);
    const one = (await pool().query("SELECT mode, user_ids, document_id FROM ack_outbox WHERE id = $1", [single])).rows[0];
    assert.deepEqual(one, { mode: "request", user_ids: [newbie.id], document_id: w1.id });
    await pool().query("DELETE FROM ack_outbox WHERE id = $1", [single]);

    // Running the enrolment again moves nothing and tells nobody.
    const again = await autoAssignPolicies(newbie.id);
    assert.deepEqual(again, { policies: [], outbox_id: null });
  });

  test("a failing reconcile never fails the write it decorates: the account is created and the membership stands, with no row (invariant 9)", async () => {
    // A trigger that refuses every assignment row of one username, so the
    // other files' hooks are untouched: what a lock timeout or a bad rule
    // would do to this person's enrolment.
    const fn = `ackaud_hookfail_${Date.now()}`;
    const username = `${STAMP}-hookfail`;
    await pool().query(
      `CREATE FUNCTION ${fn}() RETURNS trigger AS $$
       BEGIN
         IF NEW.user_id IN (SELECT id FROM users WHERE username = '${username}') THEN
           RAISE EXCEPTION 'ackaud: the hook is made to fail';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`
    );
    await pool().query(`CREATE TRIGGER ${fn} BEFORE INSERT ON policy_assignments FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    try {
      const { hash, salt } = hashPassword("Hookfail!12345");
      const user = await createUser({
        username,
        name: `Hookfail ${STAMP}`,
        email: `${username}@example.test`,
        role: "viewer",
        passwordHash: hash,
        passwordSalt: salt,
      });
      userIds.push(user.id);
      assert.ok(user.id > 0, "the account is created although its enrolment failed");
      assert.equal((await pool().query("SELECT COUNT(*)::int AS n FROM policy_assignments WHERE user_id = $1", [user.id])).rows[0].n, 0);
      assert.ok(errors.some((e) => e.includes("[ack] could not enrol the new account")), `the failure is logged: ${errors.join(" | ")}`);
      assert.equal((await pool().query("SELECT 1 FROM ack_outbox WHERE user_ids @> $1::jsonb", [JSON.stringify([user.id])])).rowCount, 0, "no welcome");

      // The group writers: G1 reaches the 'rejoin' policy by rule and the
      // private space by grant, so each write tries to enrol the person.
      await addGroupMember(g1, user.id);
      const members = async () => (await pool().query("SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY user_id", [g1])).rows.map((r) => r.user_id);
      assert.ok((await members()).includes(user.id), "the membership is written");
      assert.ok(errors.some((e) => e.includes("[ack] could not reconcile policy")), "the policy's failure is logged and the loop goes on");
      await setGroupMembers(g1, [people.alice, user.id]);
      assert.deepEqual(await members(), [people.alice, user.id].sort((a, b) => a - b), "the sync's membership stands");
      assert.equal((await pool().query("SELECT COUNT(*)::int AS n FROM policy_assignments WHERE user_id = $1", [user.id])).rows[0].n, 0, "still no row");
      assert.equal(await hasOpenAssignment(ceilingId, people.alice), false, "alice (G1, not named by the ceiling policy's rules) is untouched by the failures");
      await removeGroupMember(g1, user.id);
      assert.ok(!(await members()).includes(user.id));
    } finally {
      console.error = origError;
      await pool().query(`DROP TRIGGER IF EXISTS ${fn} ON policy_assignments`);
      await pool().query(`DROP FUNCTION IF EXISTS ${fn}()`);
      await setGroupMembers(g1, [people.alice]);
    }
  });
});

describe("the hourly safety net and the migration", () => {
  test("reconcileAllPolicies heals a missing settings row and a missing row, keeps a confirmation made before the heal current, and audits only when something moved", async () => {
    const { id, title, v1 } = await newPolicy("heal", spaceW);
    await pool().query("DELETE FROM policy_settings WHERE document_id = $1", [id]);
    const quiet = await reconcileAllPolicies({ documentIds: [id] });
    assert.equal(quiet.policies, 1);
    assert.deepEqual({ added: quiet.added, closed: quiet.closed, reopened: quiet.reopened, failed: quiet.failed }, { added: 0, closed: 0, reopened: 0, failed: 0 });
    assert.ok(await getPolicyAudience(id), "the settings row is back");
    const audited = async () =>
      (await pool().query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ack.audience_reconciled' AND target_id = $1", [String(id)])).rows[0].n;
    assert.equal(await audited(), 0, "nothing moved, nothing audited");

    // What a rolled-back 1.12.0 binary leaves (invariant 12): carol confirmed
    // under it, with no row and no settings row. The heal writes her row
    // with the policy's cycle (the marker), so the confirmation she made
    // before the heal still counts everywhere.
    await recordAcknowledgement(id, people.carol, "", v1);
    const current = (await ackSummary(id)).current;
    assert.equal(current, 1);
    await pool().query("DELETE FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [id, people.carol]);
    await pool().query("DELETE FROM policy_settings WHERE document_id = $1", [id]);
    const healed = await reconcileAllPolicies({ documentIds: [id] });
    assert.equal(healed.added, 1);
    assert.equal(await hasOpenAssignment(id, people.carol), true);
    const carol = (await row(id, people.carol))!;
    assert.equal(at(carol.cycle_started_at), at(await marker(id)), "the healed row's cycle is the marker, not the heal");
    assert.ok(await getCurrentAck(id, people.carol), "the reader's card still shows her confirmation");
    assert.equal((await ackSummary(id)).current, current, "the summary did not move");
    assert.ok((await ackStatusForDocument(id)).find((r) => r.id === people.carol)!.acknowledged_at, "the roster keeps the confirmation");
    assert.equal((await listMyPolicies(people.carol, asScope([spaceW]))).find((r) => r.id === id)!.state, "confirmed");
    assert.ok(!(await compliancePendingUsers(id)).some((u) => u.id === people.carol), "and no notice reaches her");
    assert.equal(await audited(), 1);
    const details = (await pool().query("SELECT details, target_label FROM audit_log WHERE action = 'ack.audience_reconciled' AND target_id = $1", [String(id)])).rows[0];
    assert.equal(details.target_label, title);
    assert.deepEqual({ added: details.details.added, closed: details.details.closed }, { added: 1, closed: 0 });
  });

  test("the one-shot migration leaves every count and every roster identical on a 1.12.0-shaped database", async () => {
    // Two space-mode policies with a confirmation each, as 1.12.0 left them;
    // the rows are wiped and the flag cleared inside a transaction that is
    // rolled back, so nothing of the shared database is touched. The
    // comparison names this file's people: other files are inserting
    // accounts the migration would (rightly) also give rows to.
    const m1 = await newPolicy("migrate 1", spaceW);
    const m2 = await newPolicy("migrate 2", spaceW);
    await recordAcknowledgement(m1.id, people.alice, "", m1.v1);
    await recordAcknowledgement(m2.id, people.bob, "", m2.v1);
    const ids = [m1.id, m2.id];
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      // The counts as the portal computes them (open rows of active accounts, current against marker and cycle).
      const COUNTS = `SELECT d.id, COUNT(u.id)::int AS eligible,
                             COUNT(u.id) FILTER (WHERE EXISTS (SELECT 1 FROM acknowledgements a WHERE a.document_id = d.id AND a.user_id = u.id
                                                                 AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)))::int AS current
                      FROM documents d
                      LEFT JOIN policy_assignments pa ON pa.document_id = d.id AND pa.removed_at IS NULL AND pa.exempt_at IS NULL AND pa.user_id = ANY($2)
                      LEFT JOIN users u ON u.id = pa.user_id AND u.status = 'active'
                      WHERE d.id = ANY($1) GROUP BY d.id ORDER BY d.id`;
      const ROSTER = `SELECT document_id, user_id FROM policy_assignments
                      WHERE document_id = ANY($1) AND user_id = ANY($2) AND removed_at IS NULL AND exempt_at IS NULL ORDER BY 1, 2`;
      const before = {
        counts: (await client.query(COUNTS, [ids, userIds])).rows,
        roster: (await client.query(ROSTER, [ids, userIds])).rows,
      };
      assert.equal(before.counts.find((c) => c.id === m1.id).current, 1);
      assert.ok(before.roster.length >= 12, `every one of this file's people owes both (${before.roster.length})`);

      await client.query("DELETE FROM policy_assignments WHERE document_id = ANY($1)", [ids]);
      await client.query("DELETE FROM policy_settings WHERE document_id = ANY($1)", [ids]);
      await client.query("DELETE FROM settings WHERE key = 'policy_assignments_migrated'");
      await migratePolicyAssignments(client);
      const after = {
        counts: (await client.query(COUNTS, [ids, userIds])).rows,
        roster: (await client.query(ROSTER, [ids, userIds])).rows,
      };
      assert.deepEqual(after.counts, before.counts, "the KPI sums do not move");
      assert.deepEqual(after.roster, before.roster, "nor does any roster");
      const shape = (
        await client.query(
          "SELECT bool_and(source = 'space') AS space, bool_and(cycle_started_at = d.ack_revision_at) AS from_marker FROM policy_assignments pa JOIN documents d ON d.id = pa.document_id WHERE pa.document_id = ANY($1)",
          [ids]
        )
      ).rows[0];
      assert.deepEqual(shape, { space: true, from_marker: true }, "source 'space', the cycle dated from the marker");
      const settings = (await client.query("SELECT audience_mode, assign_new_members FROM policy_settings WHERE document_id = ANY($1)", [ids])).rows;
      assert.equal(settings.length, 2);
      assert.ok(settings.every((s) => s.audience_mode === "space" && s.assign_new_members === 1));
      assert.equal((await client.query("SELECT 1 FROM settings WHERE key = 'policy_assignments_migrated'")).rowCount, 1, "the flag is set");
      // A second run is a no-op.
      await client.query("DELETE FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [m1.id, people.carol]);
      await migratePolicyAssignments(client);
      assert.equal((await client.query("SELECT 1 FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [m1.id, people.carol])).rowCount, 0, "guarded by the flag");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    assert.equal(await hasOpenAssignment(m1.id, people.carol), true, "nothing of it stuck");
  });
});

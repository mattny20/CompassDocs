// Bulk actions across policies and people (F5, 1.14.0): the request rules
// the route answers 400 with; every action's composition over the existing
// writes (remind queues outbox rows and skips a policy inside the hour;
// set_deadline writes due_history on every open row; the owner and the
// cadence through the Settings tab's setter; reask runs the atomic reset per
// policy, skips the guarded one and emits policy.requested once per policy
// it reset; add_to_set through the set's membership
// update; remind_people writes one bundled 'due' row per policy naming the
// people; the three people levers through the assignments dispatcher); the
// 200 cap; one summary audit row per call; nothing in the request sends
// mail (the outbox rows are queued, not delivered, until the drain runs
// with a mailer); and the route: a program_read holder gets 403.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-bulk.test.ts
//
// The route tests stub next/headers to read the cookie of the request under
// test and lib/ee to a stub granting policy_ack (test/ack-sets.test.ts's
// pattern); lib/ack-bulk and the route are imported after the stubs.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  recordAcknowledgement,
  listVersions,
  ackSummary,
  getPolicySettings,
  getPolicySet,
  createPolicySet,
  updatePolicySet,
  deletePolicySet,
  createGroup,
  setGroupMembers,
  setSpaceGroups,
  createRole,
  assignRole,
  createSession,
  getAckOutboxRow,
  createWebhook,
  deleteWebhook,
} from "../src/lib/db";
// lib/compliance is loaded in before(), after the stubs below: it imports
// lib/compliance-webhooks, whose emits must see the licence the stub grants.
import type { Mailer } from "../src/lib/compliance";
import { newToken } from "../src/lib/password";
import { ASSIGNMENT_IDS_MAX, SELF_EXEMPTION_ERROR } from "../src/lib/ack-assignments";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";

// --- The request scope outside Next (the route tests) ---------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-bulk.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-bulk.virtual.js");
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

const STAMP = `ackbulk-${Date.now()}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ORIGIN = "https://docs.example.test";

let spaceId = 0;
let groupId = 0;
let anaId = 0;
let benId = 0;
let miaId = 0;
let ritaId = 0;
// The people actions reach every live policy a person owes, so their tests
// run in a second private space with their own people (Mia, the manager,
// is in both groups: her own row is the self-exemption case).
let space2Id = 0;
let group2Id = 0;
let patId = 0;
let samId = 0;
let quinnId = 0;
let roleId = 0;
const userIds: number[] = [];
const docIds: number[] = [];
const setIds: number[] = [];
const sessions: string[] = [];

type Bulk = typeof import("../src/lib/ack-bulk");
let lib: Bulk;
let compliance: typeof import("../src/lib/compliance");

// The chat channel (H3): one hook of this file's own, the transport stubbed
// (lib/webhooks' seam, as test/ack-webhooks.test.ts does), so the events the
// actions emit are read back and nothing opens a socket.
const HOOK_URL = `https://hooks.example.test/${STAMP}/bulk`;
let hookId = 0;
const posts: { url: string; body: any }[] = [];
const requestedFor = (docId: number) =>
  posts.filter((p) => p.url === HOOK_URL && p.body?.event === "policy.requested" && p.body?.policy?.id === docId);
async function waitFor<T>(read: () => T[], n: number, ms = 8000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= n || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 60));
  }
}

const TEXT = Array.from({ length: 12 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join("\n\n");
const mine = () => [anaId, benId, miaId];
const team2 = () => [patId, samId, quinnId, miaId];
// documentIds scopes the people actions to this file's policies: its people
// can also owe another file's internal-space policies, and "everything
// outstanding" must neither count nor act on those (lib/ack-bulk).
const ctx = () => ({
  actor: { id: miaId, name: "Mia Manager" },
  audit: { actor: { id: miaId, name: "Mia Manager", role: "admin" }, ip: "203.0.113.9" },
  origin: ORIGIN,
  documentIds: [...docIds],
});

/**
 * A published policy in the private space, switched on (its reconcile opens
 * a row for everyone who can see the space: this file's three people and
 * any admin another file holds), with a row for the three inserted ON
 * CONFLICT DO NOTHING so the fixture holds either way. `confirms` records
 * those people's confirmation of v1.
 */
async function policy(title: string, opts: { confirms?: number[]; space?: "one" | "two" } = {}): Promise<{ id: number; title: string; v1: number }> {
  const full = `${STAMP} ${title}`;
  const two = opts.space === "two";
  const doc = await createDocument({
    space_id: two ? space2Id : spaceId,
    title: full,
    type: "policy",
    status: "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  await switchOn(doc.id, { editDefault: null, recertMonths: null });
  const v1 = (await listVersions(doc.id))[0].id;
  await fixtureQuery(
    `INSERT INTO policy_assignments (document_id, user_id, source, cycle_started_at)
     SELECT d.id, u.id, 'space', d.ack_revision_at FROM documents d, users u
     WHERE d.id = $1 AND u.id = ANY($2::int[])
     ON CONFLICT (document_id, user_id) DO NOTHING`,
    [doc.id, two ? team2() : mine()]
  );
  for (const userId of opts.confirms ?? []) await recordAcknowledgement(doc.id, userId, "", v1);
  return { id: doc.id, title: full, v1 };
}

/** A policy in the second space (the people actions' tests). */
const policy2 = (title: string, opts: { confirms?: number[] } = {}) => policy(title, { ...opts, space: "two" });

interface Row {
  id: number;
  document_id: number;
  user_id: number;
  due_at: string | null;
  reminded_at: string | null;
  exempt_at: string | null;
  exempt_reason: string;
  due_history: { kind: string; from: string | null; to: string | null }[];
}

async function rowOf(docId: number, userId: number): Promise<Row> {
  const r = await pool().query<Row>(
    "SELECT id, document_id, user_id, due_at, reminded_at, exempt_at, exempt_reason, due_history FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
    [docId, userId]
  );
  assert.ok(r.rows[0], `a row for user ${userId} on document ${docId}`);
  return r.rows[0];
}

async function outboxRows(docId: number, mode?: string) {
  const r = await pool().query<{ id: number; mode: string; source: string; user_ids: number[] | null; payload: any; done_at: string | null; actor_name: string }>(
    "SELECT id, mode, source, user_ids, payload, done_at, actor_name FROM ack_outbox WHERE document_id = $1 AND ($2::text IS NULL OR mode = $2) ORDER BY id",
    [docId, mode ?? null]
  );
  return r.rows;
}

async function noticesFor(docId: number, userId?: number): Promise<number> {
  const r = await pool().query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM ack_notices WHERE document_id = $1 AND ($2::int IS NULL OR user_id = $2)",
    [docId, userId ?? null]
  );
  return r.rows[0].n;
}

async function auditRows(action: string, targetId: number | null): Promise<{ actor_id: number; details: Record<string, any> }[]> {
  const r = await pool().query(
    `SELECT actor_id, details FROM audit_log WHERE action = $1 AND actor_id = $2
       AND ($3::text IS NULL OR target_id = $3) ORDER BY id`,
    [action, miaId, targetId === null ? null : String(targetId)]
  );
  return r.rows;
}

/** The summary rows of one key this file's manager wrote (target compliance, id null). */
async function summaries(action: string) {
  const r = await pool().query<{ details: Record<string, any> }>(
    "SELECT details FROM audit_log WHERE action = $1 AND actor_id = $2 AND target_type = 'compliance' ORDER BY id",
    [action, miaId]
  );
  return r.rows;
}

const ymdIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

before(async () => {
  await getSetting("__schema_bootstrap__");
  lib = await import("../src/lib/ack-bulk");
  compliance = await import("../src/lib/compliance");
  const { webhookTransport } = await import("../src/lib/webhooks");
  webhookTransport.post = async (url, body) => {
    posts.push({ url, body: JSON.parse(body) });
    return { ok: true, status: 200 };
  };
  hookId = (await createWebhook({ name: `${STAMP} bulk`, url: HOOK_URL, format: "generic", events: ["policy.requested"] })).id;
  const sp = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id",
    [`Ack Bulk ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Ana Ruiz', $2, 'viewer', 'active'),
       ($3, 'Ben Okoro', $4, 'viewer', 'active'),
       ($5, 'Mia Manager', $6, 'admin', 'active'),
       ($7, 'Rita Reader', $8, 'viewer', 'active')
     RETURNING id`,
    [
      `${STAMP}-ana`,
      `${STAMP}-ana@example.test`,
      `${STAMP}-ben`,
      `${STAMP}-ben@example.test`,
      `${STAMP}-mia`,
      `${STAMP}-mia@example.test`,
      `${STAMP}-rita`,
      `${STAMP}-rita@example.test`,
    ]
  );
  [anaId, benId, miaId, ritaId] = users.rows.map((r: { id: number }) => r.id);
  userIds.push(anaId, benId, miaId, ritaId);
  groupId = (await createGroup({ name: `${STAMP} readers` })).id;
  await setGroupMembers(groupId, [anaId, benId, miaId]);
  await setSpaceGroups(spaceId, [groupId]);
  const sp2 = await fixtureQuery(
    "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id",
    [`Ack Bulk People ${STAMP}`, `${STAMP}-2`]
  );
  space2Id = sp2.rows[0].id;
  const team = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Pat Lee', $2, 'viewer', 'active'),
       ($3, 'Sam Cole', $4, 'viewer', 'active'),
       ($5, 'Quinn Ash', $6, 'viewer', 'active')
     RETURNING id`,
    [`${STAMP}-pat`, `${STAMP}-pat@example.test`, `${STAMP}-sam`, `${STAMP}-sam@example.test`, `${STAMP}-quinn`, `${STAMP}-quinn@example.test`]
  );
  [patId, samId, quinnId] = team.rows.map((r: { id: number }) => r.id);
  userIds.push(patId, samId, quinnId);
  group2Id = (await createGroup({ name: `${STAMP} team` })).id;
  await setGroupMembers(group2Id, team2());
  await setSpaceGroups(space2Id, [group2Id]);
  // Rita holds the Compliance section and nothing more (compliance.program_read).
  const role = await createRole({ name: `Bulk reader ${STAMP}`, permissions: ["compliance.program_read"] });
  assert.ok("id" in role, "the read-only role exists");
  roleId = (role as { id: number }).id;
  await assignRole({ roleId, userId: ritaId });
});

after(async () => {
  if (hookId) await deleteWebhook(hookId).catch(() => {});
  for (const id of setIds) await deletePolicySet(id).catch(() => {});
  await fixtureQuery("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM policy_settings WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  // Only this file's own writes: its people's actions, and rows on its
  // documents (target_type paired, so another file's user, set or snapshot
  // with the same number keeps its row).
  await fixtureQuery("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (target_type = 'document' AND target_id = ANY($2))", [
    userIds,
    docIds.map(String),
  ]);
  await fixtureQuery("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  if (roleId) await fixtureQuery("DELETE FROM roles WHERE id = $1", [roleId]);
  await fixtureQuery("DELETE FROM groups WHERE id = ANY($1)", [[groupId, group2Id]]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = ANY($1)", [[spaceId, space2Id]]);
});

// --- The rules (pure) -------------------------------------------------------------

describe("parseBulkRequest", () => {
  test("the action, the id lists and the cap, each refused with its sentence", () => {
    const p = () => lib.parseBulkRequest;
    assert.deepEqual(p()(null), { ok: false, error: "Send a JSON object." });
    assert.deepEqual(p()({ action: "frobnicate", doc_ids: [1] }), { ok: false, error: lib.BULK_UNKNOWN_ACTION });
    assert.deepEqual(p()({ action: "remind" }), { ok: false, error: lib.BULK_DOC_IDS });
    assert.deepEqual(p()({ action: "remind", doc_ids: [1, "2"] }), { ok: false, error: lib.BULK_IDS_INTEGERS });
    assert.deepEqual(p()({ action: "remind", doc_ids: [0] }), { ok: false, error: lib.BULK_IDS_INTEGERS });
    const many = Array.from({ length: lib.BULK_IDS_MAX + 1 }, (_, i) => i + 1);
    assert.deepEqual(p()({ action: "remind", doc_ids: many }), { ok: false, error: lib.BULK_DOC_IDS });
    assert.equal(lib.BULK_IDS_MAX, ASSIGNMENT_IDS_MAX, "the cap is the assignments routes' cap");
    assert.equal(lib.BULK_IDS_MAX, 200);
    assert.deepEqual(p()({ action: "remind_people" }), { ok: false, error: lib.BULK_PEOPLE_IDS });
    assert.deepEqual(p()({ action: "remind_people", user_ids: many }), { ok: false, error: lib.BULK_PEOPLE_IDS });
    const ok = p()({ action: "remind", doc_ids: [3, 3, 1] });
    assert.ok(ok.ok);
    assert.deepEqual(ok.req.doc_ids, [3, 1], "duplicates collapse, order kept");
    const rows = p()({ action: "remind_people", assignment_ids: [7] });
    assert.ok(rows.ok && rows.req.assignment_ids[0] === 7 && rows.req.user_ids.length === 0, "the single-assignment form");
    assert.deepEqual([...lib.BULK_ACTIONS], [
      "remind",
      "set_deadline",
      "set_owner",
      "set_reminders",
      "reask",
      "add_to_set",
      "remind_people",
      "reask_people",
      "exempt_people",
      "extend_people",
    ]);
  });

  test("the reasons, the days, the date, the owner, the set, the deadline and the cadence", () => {
    const p = lib.parseBulkRequest;
    const now = new Date("2026-10-20T12:00:00Z");
    assert.deepEqual(p({ action: "reask", doc_ids: [1], params: { reason: "too short" } }, now), { ok: false, error: lib.BULK_REASON_SHORT });
    assert.deepEqual(p({ action: "reask_people", user_ids: [1], params: { reason: "short" } }, now), { ok: false, error: lib.BULK_REASON_SHORT });
    assert.ok(p({ action: "reask", doc_ids: [1], params: { reason: "Section 4 now covers contractors" } }, now).ok);
    assert.deepEqual(p({ action: "exempt_people", user_ids: [1], doc_ids: [2], params: {} }, now), { ok: false, error: lib.BULK_EXEMPT_REASON });
    assert.deepEqual(p({ action: "exempt_people", user_ids: [1], params: { reason: "On leave" } }, now), { ok: false, error: lib.BULK_EXEMPT_DOCS });
    assert.deepEqual(p({ action: "exempt_people", user_ids: [1], doc_ids: [2], params: { reason: "On leave", until: "2026-10-20" } }, now), {
      ok: false,
      error: lib.BULK_UNTIL,
    });
    const ex = p({ action: "exempt_people", user_ids: [1], doc_ids: [2], params: { reason: " On leave ", until: "2026-12-01" } }, now);
    assert.ok(ex.ok && ex.req.params.reason === "On leave" && ex.req.params.until === "2026-12-01");
    for (const days of [0, 366, "x", 1.5]) {
      assert.deepEqual(p({ action: "extend_people", user_ids: [1], params: { days } }, now), { ok: false, error: lib.BULK_DAYS }, `days ${days}`);
    }
    const ext = p({ action: "extend_people", user_ids: [1], params: {} }, now);
    assert.ok(ext.ok && ext.req.params.days === 7, "7 days when absent");
    assert.deepEqual(p({ action: "set_owner", doc_ids: [1], params: { owner_id: "5" } }, now), { ok: false, error: lib.BULK_OWNER });
    assert.ok(p({ action: "set_owner", doc_ids: [1], params: { owner_id: null } }, now).ok, "null = nobody");
    assert.deepEqual(p({ action: "add_to_set", doc_ids: [1], params: {} }, now), { ok: false, error: lib.BULK_SET_ID });
    assert.deepEqual(p({ action: "set_deadline", doc_ids: [1], params: {} }, now), { ok: false, error: lib.BULK_DEADLINE });
    assert.deepEqual(p({ action: "set_deadline", doc_ids: [1], params: { due_days: 400 } }, now), { ok: false, error: lib.BULK_DEADLINE });
    assert.deepEqual(p({ action: "set_deadline", doc_ids: [1], params: { due_days: 10, due_at: "2026-11-01" } }, now), { ok: false, error: lib.BULK_DEADLINE });
    assert.deepEqual(p({ action: "set_deadline", doc_ids: [1], params: { due_at: "2026-10-19" } }, now), { ok: false, error: lib.BULK_DEADLINE_PAST });
    assert.deepEqual(p({ action: "set_deadline", doc_ids: [1], params: { due_at: "2026-11-01", move_existing: "yes" } }, now), {
      ok: false,
      error: lib.BULK_MOVE_EXISTING,
    });
    const inherit = p({ action: "set_deadline", doc_ids: [1], params: { due_days: null, due_at: null } }, now);
    assert.ok(inherit.ok && inherit.req.params.due.due_days === null && inherit.req.params.due.due_at === null);
    const fixed = p({ action: "set_deadline", doc_ids: [1], params: { due_at: "2026-10-20", move_existing: true } }, now);
    assert.ok(fixed.ok && fixed.req.params.due.due_at === "2026-10-20" && fixed.req.params.move_existing, "today counts");
    assert.deepEqual(p({ action: "set_reminders", doc_ids: [1], params: {} }, now), { ok: false, error: lib.BULK_REMINDERS });
    assert.deepEqual(p({ action: "set_reminders", doc_ids: [1], params: { remind_before_days: 0 } }, now), {
      ok: false,
      error: "'remind_before_days' must be a whole number from 1 to 365, or null to inherit.",
    });
    const cad = p({ action: "set_reminders", doc_ids: [1], params: { remind_before_days: 5, nudge_every_days: null, days: 3 } }, now);
    assert.ok(cad.ok);
    assert.deepEqual(cad.req.params.cadence, { remind_before_days: 5, nudge_every_days: null }, "only the cadence keys travel");
  });
});

// --- The policy actions -----------------------------------------------------------

describe("the policy actions", () => {
  test("remind: one 'reminder' outbox row per policy, the rows stamped, a policy inside the hour skipped with the minutes, nothing delivered until the drain runs", async () => {
    const a = await policy("remind A");
    const b = await policy("remind B");
    await pool().query("UPDATE documents SET ack_last_reminded_at = now() - interval '20 minutes' WHERE id = $1", [b.id]);

    const r = await lib.runBulkAction({ action: "remind", doc_ids: [a.id, b.id, 999_999_999], user_ids: [], assignment_ids: [], params: blankParams() }, ctx());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.equal(body.done, 1);
    assert.ok(body.queued >= 3, `queued ${body.queued}: at least Ana, Ben and Mia`);
    assert.equal(body.skipped.length, 2);
    const skippedB = body.skipped.find((s) => s.id === b.id)!;
    assert.equal(skippedB.title, b.title);
    assert.match(skippedB.reason, /^reminded \d+ minutes ago$/);
    assert.deepEqual(body.skipped.find((s) => s.id === 999_999_999), { id: 999_999_999, title: "#999999999", reason: "not found" });

    // Queued, not sent: one 'reminder' row for A, open; no notice recorded; B untouched.
    const rowsA = await outboxRows(a.id, "reminder");
    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].done_at, null);
    assert.equal(rowsA[0].source, "manual");
    assert.equal(rowsA[0].actor_name, "Mia Manager");
    assert.equal(rowsA[0].user_ids, null, "everyone pending at delivery");
    assert.equal(await noticesFor(a.id), 0, "nothing reached anyone in the request");
    assert.equal((await outboxRows(b.id)).length, 0);
    for (const u of mine()) assert.ok((await rowOf(a.id, u)).reminded_at, "the rows are stamped for the cadence");
    const stamp = await pool().query<{ at: string | null }>("SELECT ack_last_reminded_at AS at FROM documents WHERE id = $1", [a.id]);
    assert.ok(stamp.rows[0].at, "the hour claim is stamped");
    const sums = await summaries("ack.bulk_remind");
    assert.equal(sums.length, 1);
    assert.deepEqual(sums[0].details.doc_ids, [a.id]);
    assert.equal(sums[0].details.policies, 1);
    assert.equal(sums[0].details.skipped, 2);

    // The drain, with a counting mailer, is what delivers: the mail goes out now, not in the request.
    const sent: string[][] = [];
    const mailer: Mailer = async (to) => {
      sent.push(to);
    };
    for (let i = 0; i < 6 && !(await getAckOutboxRow(rowsA[0].id))?.done_at; i++) {
      await compliance.deliverAckNotices({ origin: ORIGIN, mailer, limit: 50, documentIds: [a.id] });
    }
    assert.ok((await getAckOutboxRow(rowsA[0].id))?.done_at, "the drain completed the row");
    assert.ok((await noticesFor(a.id)) >= 3, "the notice log has a row per person");
    assert.ok(sent.length >= 3, `the drain mailed ${sent.length} people`);

    // A second Remind of A inside the hour is skipped, not re-queued.
    const again = await lib.runBulkAction({ action: "remind", doc_ids: [a.id], user_ids: [], assignment_ids: [], params: blankParams() }, ctx());
    assert.equal(again.status, 200);
    assert.equal((again.body as any).done, 0);
    assert.match((again.body as any).skipped[0].reason, /^reminded \d+ minutes? ago$/);
    assert.equal((await outboxRows(a.id, "reminder")).length, 1);
  });

  test("set_deadline: the rule through the Settings tab's setter, due_history on every open row, ack.due_set per policy, one summary, the previous rule on the answer", async () => {
    const c = await policy("deadline C");
    const d = await policy("deadline D");
    const day = ymdIn(10);
    const r = await lib.runBulkAction(
      { action: "set_deadline", doc_ids: [c.id, d.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), due: { due_days: null, due_at: day } } },
      ctx()
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.equal(body.done, 2);
    assert.equal(body.queued, 0);
    assert.deepEqual(body.previous, [
      { id: c.id, due_days: null, due_at: null },
      { id: d.id, due_days: null, due_at: null },
    ]);
    for (const doc of [c, d]) {
      const ps = await getPolicySettings(doc.id);
      assert.equal(ps?.due_at, day, "the fixed date is stored");
      assert.equal(ps?.due_days, null);
      for (const u of mine()) {
        const row = await rowOf(doc.id, u);
        assert.ok(row.due_at, "every open row has the date");
        assert.equal(row.due_at!.slice(0, 10) <= day && row.due_at!.slice(0, 10) >= ymdIn(9), true, `due ${row.due_at} on the day's end`);
        const last = row.due_history[row.due_history.length - 1];
        assert.equal(last?.kind, "moved", "the move is on the row's history");
      }
      const set = await auditRows("ack.due_set", doc.id);
      assert.equal(set.length, 1);
      assert.equal(set[0].details.via, "bulk");
      assert.equal(set[0].details.moved_existing, true);
      assert.ok(set[0].details.moved >= 3);
    }
    const sums = await summaries("ack.bulk_due_set");
    assert.equal(sums.length, 1);
    assert.equal(sums[0].details.policies, 2);
    assert.equal(sums[0].details.due_at, day);

    // Days without move_existing: the rule changes, the rows keep their dates.
    const before = (await rowOf(c.id, anaId)).due_history.length;
    const days = await lib.runBulkAction(
      { action: "set_deadline", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), due: { due_days: 30, due_at: null } } },
      ctx()
    );
    assert.equal(days.status, 200);
    assert.deepEqual((days.body as any).previous, [{ id: c.id, due_days: null, due_at: day }]);
    assert.equal((await getPolicySettings(c.id))?.due_days, 30);
    assert.equal((await rowOf(c.id, anaId)).due_history.length, before, "no move without move_existing");
    // The same rule again changes nothing: skipped, no audit row.
    const same = await lib.runBulkAction(
      { action: "set_deadline", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), due: { due_days: 30, due_at: null } } },
      ctx()
    );
    assert.equal((same.body as any).done, 0);
    assert.deepEqual((same.body as any).skipped, [{ id: c.id, title: c.title, reason: "already set" }]);
    assert.equal((await auditRows("ack.due_set", c.id)).length, 2);
    // Inherit with move_existing: the rows are recomputed from the cascade (the Undo's path).
    const inherit = await lib.runBulkAction(
      { action: "set_deadline", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), due: { due_days: null, due_at: null }, move_existing: true } },
      ctx()
    );
    assert.equal((inherit.body as any).done, 1);
    assert.equal((await rowOf(c.id, anaId)).due_history.length, before + 1, "moved back");
    assert.equal(summariesCount(await summaries("ack.bulk_due_set")), 4, "one summary per call");
  });

  test("set_owner: an active account that can see the space, per policy; the rest skipped; previous for Undo; one summary", async () => {
    const c = await policy("owner C");
    const d = await policy("owner D");
    const r = await lib.runBulkAction({ action: "set_owner", doc_ids: [c.id, d.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), owner_id: anaId } }, ctx());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as any).done, 2);
    assert.deepEqual((r.body as any).previous, [
      { id: c.id, owner_id: null },
      { id: d.id, owner_id: null },
    ]);
    assert.equal((await getPolicySettings(c.id))?.owner_user_id, anaId);
    const set = await auditRows("ack.defaults_set", c.id);
    assert.equal(set.length, 1);
    assert.deepEqual({ key: set[0].details.key, from: set[0].details.from, to: set[0].details.to, via: set[0].details.via }, { key: "owner_user_id", from: null, to: anaId, via: "bulk" });

    const same = await lib.runBulkAction({ action: "set_owner", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), owner_id: anaId } }, ctx());
    assert.deepEqual((same.body as any).skipped, [{ id: c.id, title: c.title, reason: "already the owner" }]);

    // Rita cannot see the private space: skipped per policy, nothing written.
    const rita = await lib.runBulkAction({ action: "set_owner", doc_ids: [c.id, d.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), owner_id: ritaId } }, ctx());
    assert.equal((rita.body as any).done, 0);
    assert.equal((rita.body as any).skipped[0].reason, "the owner can't see this policy's space");
    assert.equal((await getPolicySettings(c.id))?.owner_user_id, anaId);
    const nobody = await lib.runBulkAction({ action: "set_owner", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), owner_id: 999_999_999 } }, ctx());
    assert.deepEqual(nobody, { status: 400, body: { error: lib.BULK_OWNER_NOT_FOUND } });

    // Null clears: previous carries Ana for the Undo.
    const cleared = await lib.runBulkAction({ action: "set_owner", doc_ids: [c.id, d.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), owner_id: null } }, ctx());
    assert.equal((cleared.body as any).done, 2);
    assert.deepEqual((cleared.body as any).previous, [
      { id: c.id, owner_id: anaId },
      { id: d.id, owner_id: anaId },
    ]);
    assert.equal((await getPolicySettings(c.id))?.owner_user_id, null);
    assert.equal((await summaries("ack.bulk_owner_set")).length, 4, "one per call; the 400 wrote none");
  });

  test("set_reminders: the keys sent are written (null = inherit), one ack.defaults_set per changed key, previous for Undo, one summary", async () => {
    const c = await policy("reminders C");
    const r = await lib.runBulkAction(
      { action: "set_reminders", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), cadence: { remind_before_days: 5, nudge_every_days: null } } },
      ctx()
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as any).done, 1);
    assert.deepEqual((r.body as any).previous, [{ id: c.id, remind_before_days: null, nudge_every_days: null }]);
    const ps = await getPolicySettings(c.id);
    assert.equal(ps?.remind_before_days, 5);
    assert.equal(ps?.nudge_every_days, null);
    assert.equal(ps?.remind_every_days, null, "a key not sent is untouched");
    const set = await auditRows("ack.defaults_set", c.id);
    assert.equal(set.length, 1, "nudge null → null is not a change");
    assert.equal(set[0].details.key, "remind_before_days");
    const same = await lib.runBulkAction(
      { action: "set_reminders", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), cadence: { remind_before_days: 5 } } },
      ctx()
    );
    assert.deepEqual((same.body as any).skipped, [{ id: c.id, title: c.title, reason: "already set" }]);
    const back = await lib.runBulkAction(
      { action: "set_reminders", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), cadence: { remind_before_days: null } } },
      ctx()
    );
    assert.equal((back.body as any).done, 1);
    assert.equal((await getPolicySettings(c.id))?.remind_before_days, null, "inherits again");
    const sums = await summaries("ack.bulk_reminders_set");
    assert.equal(sums.length, 3);
    assert.deepEqual(sums[0].details.keys, ["remind_before_days", "nudge_every_days"]);
  });

  test("reask: the atomic reset per policy with its ledger row and notice, the guarded policy skipped with the minutes, a policy nobody confirmed skipped, one summary", async () => {
    const e = await policy("reask E", { confirms: [benId] });
    const f = await policy("reask F", { confirms: [benId] });
    const g = await policy("reask G");
    await pool().query("UPDATE documents SET ack_last_reminded_at = now() - interval '10 minutes' WHERE id = $1", [f.id]);
    const reason = "Section 4 now covers contractors too";
    const r = await lib.runBulkAction({ action: "reask", doc_ids: [e.id, f.id, g.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), reason } }, ctx());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.equal(body.done, 1);
    assert.equal(body.reset, 1);
    assert.ok(body.queued >= 3);
    assert.match(body.skipped.find((s) => s.id === f.id)!.reason, /^asked again \d+ minutes ago$/);
    assert.equal(body.skipped.find((s) => s.id === g.id)!.reason, "nobody has confirmed this version yet");
    assert.equal((await ackSummary(e.id)).current, 0, "Ben's confirmation of E lapsed");
    assert.equal((await ackSummary(f.id)).current, 1, "F was not reset");
    const updated = await outboxRows(e.id, "updated");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].source, "manual");
    assert.equal(updated[0].done_at, null, "queued, not sent");
    assert.equal((await outboxRows(f.id)).length, 0);
    const asked = await auditRows("ack.reconfirmation_requested", e.id);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].details.scope, "all");
    assert.equal(asked[0].details.via, "bulk");
    assert.equal(asked[0].details.reason, reason);
    assert.equal((await auditRows("ack.reconfirmation_requested", f.id)).length, 0);
    const sums = await summaries("ack.bulk_reasked");
    assert.equal(sums.length, 1);
    assert.deepEqual({ scope: sums[0].details.scope, policies: sums[0].details.policies, reset: sums[0].details.reset }, { scope: "all", policies: 1, reset: 1 });

    // H3: the whole-audience re-ask tells the channel once per policy it
    // reset, as the single-policy route does; the skipped ones say nothing.
    const told = await waitFor(() => requestedFor(e.id), 1);
    assert.equal(told.length, 1, "one policy.requested for E");
    assert.equal(told[0].body.policy.people, body.queued, "the people asked again");
    assert.equal(told[0].body.actor, "Mia Manager");
    assert.equal(told[0].body.url, `${ORIGIN}/compliance/policies?policy=${e.id}`);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(requestedFor(e.id).length, 1, "not one per person");
    assert.equal(requestedFor(f.id).length + requestedFor(g.id).length, 0, "a skipped policy tells no channel");
  });

  test("add_to_set: the set's membership update, a member already in it skipped, a non-policy skipped, an unknown set 404, a deactivated set 409, nobody assigned", async () => {
    const c = await policy("set C");
    const d = await policy("set D");
    const set = await createPolicySet({ name: `${STAMP} Onboarding`, description: "", doc_ids: [c.id], assign_new_members: false }, ctx().actor);
    setIds.push(set.id);
    const rowsBefore = (await pool().query("SELECT COUNT(*)::int AS n FROM policy_assignments WHERE document_id = $1", [d.id])).rows[0].n;
    const r = await lib.runBulkAction(
      { action: "add_to_set", doc_ids: [c.id, d.id, 999_999_999], user_ids: [], assignment_ids: [], params: { ...blankParams(), set_id: set.id } },
      ctx()
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as any).done, 1);
    assert.deepEqual((r.body as any).skipped, [
      { id: c.id, title: c.title, reason: "already in the set" },
      { id: 999_999_999, title: "#999999999", reason: "not found" },
    ]);
    const after = await getPolicySet(set.id);
    assert.deepEqual(after?.docs.map((x) => x.id), [c.id, d.id], "appended in order");
    const rowsAfter = (await pool().query("SELECT COUNT(*)::int AS n FROM policy_assignments WHERE document_id = $1", [d.id])).rows[0].n;
    assert.equal(rowsAfter, rowsBefore, "adding to a set assigns nobody");
    const edited = await pool().query("SELECT details FROM audit_log WHERE action = 'ack.set_updated' AND target_id = $1 AND actor_id = $2", [String(set.id), miaId]);
    assert.equal(edited.rows.length, 1);
    assert.deepEqual(edited.rows[0].details.added, [d.id]);
    const sums = await summaries("ack.bulk_added_to_set");
    assert.equal(sums.length, 1);
    assert.equal(sums[0].details.set_id, set.id);
    assert.equal(sums[0].details.policies, 1);

    const missing = await lib.runBulkAction({ action: "add_to_set", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), set_id: 999_999_999 } }, ctx());
    assert.deepEqual(missing, { status: 404, body: { error: lib.BULK_SET_NOT_FOUND } });
    await updatePolicySet(set.id, { active: false });
    const off = await lib.runBulkAction({ action: "add_to_set", doc_ids: [c.id], user_ids: [], assignment_ids: [], params: { ...blankParams(), set_id: set.id } }, ctx());
    assert.deepEqual(off, { status: 409, body: { error: lib.BULK_SET_DEACTIVATED } });
  });
});

// --- The people actions -----------------------------------------------------------

describe("the people actions", () => {
  test("remind_people: one bundled 'due' row per policy naming the people with their dates, the rows stamped, the hour and nothing-outstanding skips, the drain bundling a person on more than three rows", async () => {
    const docs = [] as { id: number; title: string }[];
    for (const t of ["people H", "people I", "people J", "people K"]) docs.push(await policy2(t));
    const [h] = docs;
    await recordAcknowledgement(h.id, samId, "", (await listVersions(h.id))[0].id);
    // Quinn was reminded ten minutes ago on everything she owes.
    await pool().query("UPDATE policy_assignments SET reminded_at = now() - interval '10 minutes' WHERE user_id = $1", [quinnId]);
    const r = await lib.runBulkAction(
      { action: "remind_people", doc_ids: [], user_ids: [patId, samId, quinnId, ritaId, 999_999_999], assignment_ids: [], params: blankParams() },
      ctx()
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.equal(body.done, 7, "Pat's four rows and Sam's three");
    assert.equal(body.queued, 2);
    const skipped = Object.fromEntries(body.skipped.map((s) => [s.id, s]));
    assert.match(skipped[quinnId].reason, /^reminded \d+ minutes ago$/);
    assert.equal(skipped[quinnId].title, "Quinn Ash");
    assert.deepEqual(skipped[ritaId], { id: ritaId, title: "Rita Reader", reason: "nothing outstanding" });
    assert.deepEqual(skipped[999_999_999], { id: 999_999_999, title: "#999999999", reason: "not found" });

    for (const doc of docs) {
      const rows = await outboxRows(doc.id, "due");
      assert.equal(rows.length, 1, `one 'due' row for ${doc.title}`);
      assert.equal(rows[0].done_at, null);
      assert.equal(rows[0].source, "manual");
      const expected = doc.id === h.id ? [patId] : [patId, samId];
      assert.deepEqual([...rows[0].user_ids!].sort(), expected.sort());
      assert.deepEqual(
        rows[0].payload.rows.map((x: { user_id: number }) => x.user_id).sort(),
        expected.sort(),
        "the payload names each person with their date"
      );
      assert.ok(rows[0].payload.rows.every((x: { overdue: boolean }) => x.overdue === false));
      assert.equal(await noticesFor(doc.id), 0, "nothing reached anyone in the request");
      assert.ok((await rowOf(doc.id, patId)).reminded_at, "Pat's row is stamped");
    }
    const sums = await summaries("ack.bulk_people_reminded");
    assert.equal(sums.length, 1);
    assert.deepEqual({ people: sums[0].details.people, rows: sums[0].details.rows, policies: sums[0].details.policies }, { people: 2, rows: 7, policies: 4 });

    // The drain: Ana, on four rows (more than DUE_BUNDLE_OVER), gets one
    // notice listing her policies and one mail; Ben, on three, one per policy.
    assert.equal(compliance.DUE_BUNDLE_OVER, 3);
    const sent: string[][] = [];
    const mailer: Mailer = async (to) => {
      sent.push(to);
    };
    for (let i = 0; i < 6; i++) {
      const open = await pool().query("SELECT COUNT(*)::int AS n FROM ack_outbox WHERE document_id = ANY($1) AND mode = 'due' AND done_at IS NULL", [docs.map((x) => x.id)]);
      if (open.rows[0].n === 0) break;
      await compliance.deliverAckNotices({ origin: ORIGIN, mailer, limit: 50, documentIds: docs.map((x) => x.id) });
    }
    const patMail = sent.filter((to) => to[0] === `${STAMP}-pat@example.test`).length;
    const samMail = sent.filter((to) => to[0] === `${STAMP}-sam@example.test`).length;
    assert.equal(patMail, 1, "Pat: one bundled mail");
    assert.equal(samMail, 3, "Sam: one per policy");
    for (const doc of docs) assert.equal(await noticesFor(doc.id, patId), 1, "one notice row per policy for Pat");
    assert.equal(await noticesFor(h.id, samId), 0, "Sam confirmed H: not reminded about it");

    // The single-assignment form: the named row only.
    const l = await policy2("people L");
    const row = await rowOf(l.id, patId);
    const one = await lib.runBulkAction({ action: "remind_people", doc_ids: [], user_ids: [], assignment_ids: [row.id, 999_999_999], params: blankParams() }, ctx());
    assert.equal((one.body as any).done, 1);
    assert.equal((one.body as any).queued, 1);
    assert.deepEqual((one.body as any).skipped, [{ id: 999_999_999, title: "#999999999", reason: "not an open row of a live policy" }]);
    const rowsL = await outboxRows(l.id, "due");
    assert.equal(rowsL.length, 1);
    assert.deepEqual(rowsL[0].user_ids, [patId]);
  });

  test("reask_people: the confirmed rows across every policy through the dispatcher (scope 'users'), the people with nothing skipped, the per-person brake on a repeat", async () => {
    const m = await policy2("reask people M", { confirms: [patId, samId] });
    const n = await policy2("reask people N", { confirms: [patId] });
    const reason = "The annual re-read for the audit";
    // Every confirmed row the people hold on a live policy (Sam also confirmed H above).
    const expectedRows = [await rowOf(m.id, patId), await rowOf(m.id, samId), await rowOf(n.id, patId)].map((x) => x.id);
    const r = await lib.runBulkAction({ action: "reask_people", doc_ids: [], user_ids: [patId, samId, ritaId], assignment_ids: [], params: { ...blankParams(), reason } }, ctx());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.ok(expectedRows.every((id) => body.changed!.includes(id)), "Pat on M and N, Sam on M");
    assert.equal(body.done, body.changed!.length);
    assert.equal(body.queued, 2);
    assert.equal(body.people, 2);
    assert.deepEqual(body.skipped, [{ id: ritaId, title: "Rita Reader", reason: "nothing to re-confirm" }]);
    assert.equal((await ackSummary(m.id)).current, 0, "both confirmations of M lapsed");
    assert.equal((await ackSummary(n.id)).current, 0);
    const askedM = await auditRows("ack.reconfirmation_requested", m.id);
    assert.equal(askedM.length, 1);
    assert.equal(askedM[0].details.scope, "users");
    assert.deepEqual([...askedM[0].details.user_ids].sort(), [patId, samId].sort());
    const sums = await summaries("ack.bulk_reasked");
    const users = sums.filter((s) => s.details.scope === "users");
    assert.equal(users.length, 1);
    assert.deepEqual({ people: users[0].details.people, rows: users[0].details.rows }, { people: 2, rows: body.done });
    // Asked again at once: nobody has a confirmation left to lapse, so nothing to re-confirm.
    const again = await lib.runBulkAction({ action: "reask_people", doc_ids: [], user_ids: [patId], assignment_ids: [], params: { ...blankParams(), reason } }, ctx());
    assert.equal((again.body as any).done, 0);
    assert.equal((again.body as any).skipped[0].reason, "nothing to re-confirm");
  });

  test("exempt_people: the chosen policies' open rows through the dispatcher, the manager's own row refused, an exempt row skipped, one summary", async () => {
    const o = await policy2("exempt O");
    const p = await policy2("exempt P");
    const r = await lib.runBulkAction(
      { action: "exempt_people", doc_ids: [o.id], user_ids: [patId, samId], assignment_ids: [], params: { ...blankParams(), reason: "On leave", until: "2099-12-01" } },
      ctx()
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.equal(body.done, 2);
    assert.equal(body.people, 2);
    assert.equal(body.changed?.length, 2);
    assert.deepEqual(body.skipped, []);
    for (const u of [patId, samId]) {
      const row = await rowOf(o.id, u);
      assert.ok(row.exempt_at, "exempt");
      assert.equal(row.exempt_reason, "On leave");
    }
    assert.equal((await rowOf(p.id, patId)).exempt_at, null, "P was not chosen");
    assert.equal((await auditRows("ack.exempted", o.id)).length, 2, "the dispatcher's per-row rows");
    const sums = await summaries("ack.bulk_exempted");
    assert.equal(sums.length, 1);
    assert.deepEqual({ people: sums[0].details.people, rows: sums[0].details.rows, policies: sums[0].details.policies }, { people: 2, rows: 2, policies: 1 });

    const self = await lib.runBulkAction(
      { action: "exempt_people", doc_ids: [p.id], user_ids: [miaId], assignment_ids: [], params: { ...blankParams(), reason: "Myself, which is refused" } },
      ctx()
    );
    assert.deepEqual(self, { status: 400, body: { error: SELF_EXEMPTION_ERROR } });
    const again = await lib.runBulkAction(
      { action: "exempt_people", doc_ids: [o.id], user_ids: [patId], assignment_ids: [], params: { ...blankParams(), reason: "Still on leave" } },
      ctx()
    );
    assert.equal((again.body as any).done, 0);
    assert.deepEqual((again.body as any).skipped, [{ id: patId, title: "Pat Lee", reason: "already exempt" }]);

    // The picker's read: O no longer lists the exempt rows; P lists everyone.
    const policies = await lib.bulkPeoplePolicies([patId, samId]);
    const pRow = policies.find((x) => x.id === p.id);
    assert.deepEqual(pRow, { id: p.id, title: p.title, people: 2, open: 2, confirmed: 0 });
    assert.equal(policies.find((x) => x.id === o.id), undefined, "exempt rows leave the picker");
  });

  test("extend_people: the open deadlines through the dispatcher, a confirmed person skipped, exactly one ack.bulk_extended per call", async () => {
    const q = await policy2("extend Q", { confirms: [samId] });
    const before = await rowOf(q.id, patId);
    const sam = await rowOf(q.id, samId);
    // The single-assignment form bounds the call to Q's rows (the user_ids form reaches every policy the people owe).
    const r = await lib.runBulkAction(
      { action: "extend_people", doc_ids: [], user_ids: [], assignment_ids: [before.id, sam.id], params: { ...blankParams(), days: 10 } },
      ctx()
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as import("../src/lib/ack-bulk").BulkAnswer;
    assert.equal(body.done, 1);
    assert.equal(body.people, 1);
    assert.deepEqual(body.changed, [before.id]);
    assert.deepEqual(body.skipped, [{ id: samId, title: "Sam Cole", reason: "nothing outstanding" }]);
    const after = await rowOf(q.id, patId);
    const base = Math.max(before.due_at ? Date.parse(before.due_at) : 0, Date.now() - 60_000);
    assert.ok(Date.parse(after.due_at!) >= base + 10 * DAY - 5_000, `extended by ten days: ${after.due_at}`);
    const one = (await summaries("ack.bulk_extended")).filter((s) => s.details.days === 10);
    assert.equal(one.length, 1, "one summary for a one-row call (written here)");
    // Two rows: the dispatcher writes the summary; this call does not add a second.
    const mia = await rowOf(q.id, miaId);
    const two = await lib.runBulkAction(
      { action: "extend_people", doc_ids: [], user_ids: [], assignment_ids: [before.id, mia.id], params: { ...blankParams(), days: 3 } },
      ctx()
    );
    assert.equal((two.body as any).done, 2);
    const three = (await summaries("ack.bulk_extended")).filter((s) => s.details.days === 3);
    assert.equal(three.length, 1, "one summary for a two-row call (the dispatcher's)");
    // The user_ids form reaches everything Pat owes: at least Q.
    const all = await lib.runBulkAction({ action: "extend_people", doc_ids: [], user_ids: [patId], assignment_ids: [], params: { ...blankParams(), days: 1 } }, ctx());
    assert.ok((all.body as any).changed.includes(before.id));
    assert.ok((all.body as any).done >= 1);
  });
});

// --- The route ----------------------------------------------------------------------

describe("POST /api/admin/compliance/bulk", () => {
  let route: typeof import("../src/app/api/admin/compliance/bulk/route");
  let mgr = "";
  let reader = "";
  const BASE = "http://localhost/api/admin/compliance/bulk";

  before(async () => {
    route = await import("../src/app/api/admin/compliance/bulk/route");
    mgr = newToken();
    reader = newToken();
    sessions.push(mgr, reader);
    await createSession(mgr, miaId, new Date(Date.now() + HOUR).toISOString());
    await createSession(reader, ritaId, new Date(Date.now() + HOUR).toISOString());
  });

  test("a program_read holder gets 403 on both verbs; a manager's bad bodies are 400 with the sentence; a good one answers the shape", async () => {
    const d = await policy("route D");
    const denied = await answer(() => route.POST(request("POST", BASE, reader, { action: "remind", doc_ids: [d.id] })), request("POST", BASE, reader));
    assert.equal(denied.status, 403);
    const deniedGet = await answer(() => route.GET(request("GET", `${BASE}?user_ids=${anaId}`, reader)), request("GET", BASE, reader));
    assert.equal(deniedGet.status, 403);
    assert.equal((await outboxRows(d.id)).length, 0, "nothing was queued for the reader");

    const unknown = await answer(() => route.POST(request("POST", BASE, mgr, { action: "frobnicate", doc_ids: [d.id] })), request("POST", BASE, mgr));
    assert.deepEqual(unknown, { status: 400, body: { error: lib.BULK_UNKNOWN_ACTION } });
    const short = await answer(
      () => route.POST(request("POST", BASE, mgr, { action: "reask", doc_ids: [d.id], params: { reason: "short" } })),
      request("POST", BASE, mgr)
    );
    assert.deepEqual(short, { status: 400, body: { error: lib.BULK_REASON_SHORT } });
    const days = await answer(
      () => route.POST(request("POST", BASE, mgr, { action: "extend_people", user_ids: [anaId], params: { days: 400 } })),
      request("POST", BASE, mgr)
    );
    assert.deepEqual(days, { status: 400, body: { error: lib.BULK_DAYS } });
    const many = Array.from({ length: 201 }, (_, i) => i + 1);
    const cap = await answer(() => route.POST(request("POST", BASE, mgr, { action: "remind", doc_ids: many })), request("POST", BASE, mgr));
    assert.deepEqual(cap, { status: 400, body: { error: lib.BULK_DOC_IDS } });
    const junk = await answer(() => route.POST(new Request(BASE, { method: "POST", headers: { cookie: `compass_session=${mgr}`, "content-type": "application/json" }, body: "{" })), request("POST", BASE, mgr));
    assert.equal(junk.status, 400);

    const ok = await answer(() => route.POST(request("POST", BASE, mgr, { action: "remind", doc_ids: [d.id, 999_999_999] })), request("POST", BASE, mgr));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.action, "remind");
    assert.equal(ok.body.done, 1);
    assert.ok(ok.body.queued >= 3);
    assert.deepEqual(ok.body.skipped, [{ id: 999_999_999, title: "#999999999", reason: "not found" }]);
    assert.equal((await outboxRows(d.id, "reminder")).length, 1);

    const list = await answer(() => route.GET(request("GET", `${BASE}?user_ids=${anaId},${benId}`, mgr)), request("GET", BASE, mgr));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const mineD = list.body.policies.find((p: { id: number }) => p.id === d.id);
    assert.deepEqual(mineD, { id: d.id, title: d.title, people: 2, open: 2, confirmed: 0 });
    const bad = await answer(() => route.GET(request("GET", `${BASE}?user_ids=x`, mgr)), request("GET", BASE, mgr));
    assert.deepEqual(bad, { status: 400, body: { error: lib.BULK_PEOPLE_IDS } });
  });
});

/** Empty params (what parseBulkRequest hands a remind). */
function blankParams(): import("../src/lib/ack-bulk").BulkParams {
  return { days: 0, reason: "", until: null, owner_id: null, set_id: 0, due: { due_days: null, due_at: null }, move_existing: false, cadence: {} };
}

function summariesCount(rows: unknown[]): number {
  return rows.length;
}

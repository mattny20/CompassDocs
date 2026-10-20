// Ask one person to re-confirm (D4, 1.13.0). The per-person marker is
// policy_assignments.cycle_started_at: a confirmation counts while it is on
// or after both the document marker and the person's cycle stamp, so
// restarting one row's cycle lapses that person alone. The whole-audience
// path (A7) is untouched: no list moves the marker, scope 'all', the notice
// names nobody. A per-person claim writes one 'reset' ledger row of scope
// 'users' whose confirmations_affected is the rows it re-opened, one
// immediate 'updated' outbox row naming only those people, re-arms their
// deadline from the cascade, clears their reminder stamps, skips exempt,
// removed and unassigned people and reports them, takes no hour and stamps
// no cooldown. The route validates the list and echoes who was asked and
// who was skipped; the audit row carries the list.
//
// The route handlers are called directly, the way test/ack-statement.test.ts
// does it: next/headers resolves to a stub that serves the request under
// test (its session cookie), and lib/ee resolves to a stub that grants
// policy_ack.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-reask.test.ts

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
  listAckDecisions,
  lastAckDecision,
  ackSummary,
  pendingAckOutboxFor,
  getAckOutboxRow,
  listAckNotices,
  claimReconfirmation,
  reopenAssignmentsFor,
  createSession,
  createGroup,
  setGroupMembers,
  setSpaceGroups,
} from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { endOfDayIn } from "../src/lib/ack-due";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.ack-reask.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-reask.virtual.js");
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

  // lib/ee as a licensed enterprise build sees it: policy_ack is on.
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

function sessionRequest(url: string, session: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      cookie: `compass_session=${session}`,
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.31",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `ackreask-${Date.now()}`;
const ORIGIN = "https://docs.example.test";
const REASON = "Suspect three-second confirmation: please read it properly";

let spaceId = 0;
let readerA = 0;
let readerB = 0;
let exemptC = 0;
let removedD = 0;
let outsiderE = 0;
let groupId = 0;
let managerId = 0;
let managerSession = "";
const userIds: number[] = [];
const docIds: number[] = [];
const manager = () => ({ id: managerId, name: "Reask Manager" });

const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newUser(tag: string, role = "viewer"): Promise<number> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [`${STAMP}-${tag}`, `Reask ${tag}`, `${STAMP}-${tag}@example.test`, role]
  );
  userIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newPolicy(title: string): Promise<{ id: number; title: string; v1: number }> {
  const full = `${STAMP} ${title}`;
  const doc = await createDocument({
    space_id: spaceId,
    title: full,
    type: "policy",
    status: "published",
    content: LONG_TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  // Both null: leave the columns alone rather than reading the workspace
  // settings row, which another test file may be writing.
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  return { id: doc.id, title: full, v1: (await listVersions(doc.id))[0].id };
}

/**
 * One assignment row in a known state. Upserts, because setAckRequired may
 * already have enrolled the person (the audience reconcile, D1): whatever
 * it wrote, the row ends up as this test needs it, with the cycle stamp at
 * the document marker so a confirmation made now is current.
 */
async function assign(
  docId: number,
  userId: number,
  state: { exempt?: boolean; removed?: boolean; dueAt?: string | null; remindedAt?: string | null; escalatedAt?: string | null } = {}
): Promise<void> {
  await fixtureQuery(
    `INSERT INTO policy_assignments
       (document_id, user_id, source, cycle_started_at, due_at, reminded_at, reminder_count, escalated_at,
        exempt_at, exempt_by_name, exempt_reason, removed_at, removed_reason)
     SELECT d.id, $2, 'space', d.ack_revision_at, $3::timestamptz, $4::timestamptz,
            CASE WHEN $4::timestamptz IS NULL THEN 0 ELSE 2 END, $5::timestamptz,
            CASE WHEN $6::boolean THEN now() END, CASE WHEN $6::boolean THEN 'Reask Manager' ELSE '' END,
            CASE WHEN $6::boolean THEN 'On leave' ELSE '' END,
            CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN 'left_group' ELSE '' END
     FROM documents d WHERE d.id = $1
     ON CONFLICT (document_id, user_id) DO UPDATE SET
       cycle_started_at = EXCLUDED.cycle_started_at, due_at = EXCLUDED.due_at,
       reminded_at = EXCLUDED.reminded_at, reminder_count = EXCLUDED.reminder_count, escalated_at = EXCLUDED.escalated_at,
       exempt_at = EXCLUDED.exempt_at, exempt_by_name = EXCLUDED.exempt_by_name, exempt_reason = EXCLUDED.exempt_reason,
       removed_at = EXCLUDED.removed_at, removed_reason = EXCLUDED.removed_reason`,
    [docId, userId, state.dueAt ?? null, state.remindedAt ?? null, state.escalatedAt ?? null, state.exempt === true, state.removed === true]
  );
}

/** Nobody ever assigned this person the policy (a reconcile that ran may have; undo it for the fixture). */
async function unassign(docId: number, userId: number): Promise<void> {
  await pool().query("DELETE FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [docId, userId]);
}

/** The policy's own deadline rule (E1): days, or a fixed calendar day. */
async function setDueRule(docId: number, rule: { due_days?: number | null; due_at?: string | null }): Promise<void> {
  await fixtureQuery(
    `INSERT INTO policy_settings (document_id, due_days, due_at) VALUES ($1, $2, $3::date)
     ON CONFLICT (document_id) DO UPDATE SET due_days = EXCLUDED.due_days, due_at = EXCLUDED.due_at`,
    [docId, rule.due_days ?? null, rule.due_at ?? null]
  );
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const dayOffset = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const marker = (id: number) =>
  pool()
    .query("SELECT ack_revision_at::text AS at, ack_version_id, ack_last_reminded_at::text AS reminded FROM documents WHERE id = $1", [id])
    .then((r) => r.rows[0]);

interface Row {
  cycle: string;
  due: string | null;
  reminded: string | null;
  reminder_count: number;
  escalated: string | null;
  exempt: boolean;
  removed: boolean;
}
async function rowOf(docId: number, userId: number): Promise<Row | undefined> {
  const r = await pool().query<Row>(
    `SELECT cycle_started_at::text AS cycle, due_at::text AS due, reminded_at::text AS reminded, reminder_count,
            escalated_at::text AS escalated, (exempt_at IS NOT NULL) AS exempt, (removed_at IS NOT NULL) AS removed
     FROM policy_assignments WHERE document_id = $1 AND user_id = $2`,
    [docId, userId]
  );
  return r.rows[0];
}

/** The contract's currency for a person: a confirmation on or after both the marker and their cycle stamp. */
async function currentByCycle(docId: number, userId: number): Promise<boolean> {
  const r = await pool().query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM acknowledgements a
       JOIN documents d ON d.id = a.document_id
       JOIN policy_assignments pa ON pa.document_id = d.id AND pa.user_id = a.user_id
       WHERE a.document_id = $1 AND a.user_id = $2
         AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)
     ) AS current`,
    [docId, userId]
  );
  return r.rows[0].current;
}

async function ackRows(docId: number): Promise<number> {
  const r = await pool().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [docId]);
  return r.rows[0].n;
}

async function auditRows(action: string, docId: number): Promise<{ actor_id: number | null; details: Record<string, any> }[]> {
  const r = await pool().query(
    "SELECT actor_id, details FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
    [action, String(docId)]
  );
  return r.rows;
}

// This file's drains claim this file's rows only (test files share one
// database). lib/compliance is loaded lazily so its lib/ee import resolves
// to the stub installed above, not the build alias tsx cannot resolve.
const drain = async () => {
  const { deliverAckNotices } = await import("../src/lib/compliance");
  return deliverAckNotices({ origin: ORIGIN, mailer: null, limit: 50, documentIds: docIds });
};
async function drainUntil(pred: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await drain();
    if (await pred()) return;
  }
  assert.fail(`the drain never reached: ${what}`);
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'private') RETURNING id`,
    [`Ack Reask ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  readerA = await newUser("reader-a");
  readerB = await newUser("reader-b");
  exemptC = await newUser("exempt-c");
  removedD = await newUser("removed-d");
  outsiderE = await newUser("outsider-e");
  // An admin holds compliance.program_manage through the legacy ladder, the
  // second half of the route's OR.
  managerId = await newUser("manager", "admin");
  managerSession = newToken();
  await createSession(managerSession, managerId, new Date(Date.now() + 3_600_000).toISOString());
  // A private space granted to a group of this file's own people, so the
  // switch-on's reconcile enrols only them: the test files share one
  // database and run in parallel, and an 'internal' space would enrol every
  // account another file is creating and tearing down.
  groupId = (await createGroup({ name: `Ack Reask ${STAMP}` })).id;
  await setGroupMembers(groupId, [readerA, readerB, exemptC, removedD, outsiderE, managerId]);
  await setSpaceGroups(spaceId, [groupId]);
});

after(async () => {
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notifications WHERE kind = 'ack_requested' AND title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (target_type = 'document' AND target_id = ANY($2::text[]))", [
    userIds,
    docIds.map(String),
  ]);
  // policy_settings and policy_assignments cascade with the documents.
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

// --- The statement -------------------------------------------------------------------

describe("ask one person to re-confirm (D4)", () => {
  test("restarts the named person's cycle with a fresh deadline and leaves the marker, the cooldown and everyone else alone", async () => {
    const { id, title, v1 } = await newPolicy("one person");
    await setDueRule(id, { due_days: 5 });
    for (const u of [readerA, readerB]) {
      await assign(id, u, { dueAt: daysAgo(3), remindedAt: daysAgo(1), escalatedAt: daysAgo(0.5) });
      await recordAcknowledgement(id, u, "", v1);
      assert.equal(await currentByCycle(id, u), true, "both confirmations are current before the ask");
    }
    const before = await marker(id);
    assert.equal(before.reminded, null, "no Request, Remind or re-ask has stamped the cooldown");
    const bBefore = await rowOf(id, readerB);

    const r = await claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA, readerA] });
    assert.equal(r.claimed, true);
    if (!r.claimed) throw new Error("unreachable");
    assert.equal(r.scope, "users");
    assert.deepEqual(r.user_ids, [readerA], "the list is deduplicated");
    assert.deepEqual(r.skipped, []);
    assert.equal(r.confirmations_reset, 1, "the rows re-opened");
    assert.ok(r.eligible >= 1);
    assert.equal(r.version_id, v1);
    assert.equal(r.rev, 1);
    assert.equal(r.title, title);
    assert.equal(r.space_id, spaceId);
    assert.equal(r.marker, before.at, "the claim reports the marker as it stands");
    assert.ok(r.decision_id > 0 && r.outbox_id > 0);

    // The document is untouched: no marker move, no version move, no cooldown.
    assert.deepEqual(await marker(id), before);

    // The person's row: the cycle stamp is the claim's, the reminder and
    // escalation stamps are cleared, the lifetime count stays, and the
    // deadline is re-armed from the policy's rule (5 days) so a cycle that
    // starts today is not overdue today.
    const a = (await rowOf(id, readerA))!;
    const stamped = await pool().query<{ same: boolean; due_ok: boolean }>(
      `SELECT (cycle_started_at = $3::timestamptz) AS same,
              (due_at BETWEEN now() + interval '4 days 23 hours' AND now() + interval '5 days 1 hour') AS due_ok
       FROM policy_assignments WHERE document_id = $1 AND user_id = $2`,
      [id, readerA, r.asked_at]
    );
    assert.equal(stamped.rows[0].same, true, "the row carries the claim's stamp");
    assert.equal(stamped.rows[0].due_ok, true, `due_at re-armed to now + 5 days, got ${a.due}`);
    assert.equal(a.reminded, null);
    assert.equal(a.escalated, null);
    assert.equal(a.reminder_count, 2, "the lifetime reminder count is not rewritten");
    assert.notEqual(a.cycle, before.at, "the cycle stamp moved past the marker");

    // Everyone else: the same row as before, to the microsecond.
    assert.deepEqual(await rowOf(id, readerB), bBefore, "the other person's row is untouched");

    // Currency: the named person lapsed, the other did not, nothing was deleted.
    assert.equal(await currentByCycle(id, readerA), false, "the named person is asked again");
    assert.equal(await currentByCycle(id, readerB), true, "the other person's confirmation still counts");
    assert.ok(await getCurrentAck(id, readerB), "and so does the marker-only view of it");
    assert.equal(await ackRows(id), 2, "prior confirmations stay in the ledger");

    // One ledger row: reset, manual, scope 'users', the rows re-opened, the reason, the stamp.
    const rows = await listAckDecisions(id);
    assert.equal(rows.length, 1);
    const [d] = rows;
    assert.equal(d.id, r.decision_id);
    assert.equal(d.outcome, "reset");
    assert.equal(d.source, "manual");
    assert.equal(d.scope, "users");
    assert.equal(d.confirmations_affected, 1);
    assert.ok((d.eligible ?? 0) >= 1, "eligible is the audience, not the list");
    assert.equal(d.reason, REASON);
    assert.equal(d.decided_by, managerId);
    assert.equal(d.decided_by_name, "Reask Manager");
    assert.equal(d.version_id, v1);
    assert.equal(d.rev, 1);
    assert.equal(d.change_pct, null, "nothing was measured: the text did not change");
    assert.equal(d.notified_at, null, "the drain stamps it later");
    const same = await pool().query<{ same: boolean }>(
      `SELECT (x.decided_at = pa.cycle_started_at) AS same
       FROM ack_decisions x JOIN policy_assignments pa ON pa.document_id = x.document_id AND pa.user_id = $2
       WHERE x.id = $1`,
      [d.id, readerA]
    );
    assert.equal(same.rows[0].same, true, "the ledger row and the cycle stamp carry one instant");

    // The document's "last decision" is about the whole audience: a
    // per-person row is in the ledger, not the document's last ask.
    assert.equal((await ackSummary(id)).last_decision, null);
    assert.equal((await lastAckDecision(id, { outcome: "reset" }))?.id, d.id, "the ledger reader still sees it");
    assert.equal(await lastAckDecision(id, { scope: "all" }), null);

    // One immediate notice, naming only the person asked, with the reason.
    const queued = await pendingAckOutboxFor(id);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, r.outbox_id);
    assert.equal(queued[0].mode, "updated");
    assert.equal(queued[0].source, "manual");
    assert.deepEqual(queued[0].user_ids, [readerA]);
    assert.equal(queued[0].reason, REASON);
    assert.equal(queued[0].actor_id, managerId);
    assert.ok(new Date(queued[0].not_before).getTime() <= Date.now() + 1000, "manual asks go out at once");

    // No hour: asking another person straight after goes through, and the
    // first person's row is not touched twice.
    const again = await claimReconfirmation(null, id, { source: "manual", reason: "Returning from leave", actor: manager(), userIds: [readerB] });
    assert.equal(again.claimed, true);
    if (!again.claimed) throw new Error("unreachable");
    assert.deepEqual(again.user_ids, [readerB]);
    assert.deepEqual(await rowOf(id, readerA), a);
    assert.equal(await currentByCycle(id, readerB), false);
    assert.equal((await listAckDecisions(id)).length, 2);
    assert.equal((await pendingAckOutboxFor(id)).length, 2);
    assert.deepEqual(await marker(id), before, "still no marker move, still no cooldown");
  });

  test("the re-armed deadline follows the cascade: a fixed date still ahead is kept, a past one falls back to the days rule", async () => {
    const ahead = await newPolicy("fixed ahead");
    await setDueRule(ahead.id, { due_days: 3, due_at: dayOffset(10) });
    await assign(ahead.id, readerA, { dueAt: daysAgo(20) });
    const kept = await claimReconfirmation(null, ahead.id, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA] });
    assert.equal(kept.claimed, true);
    // The one re-arm fragment (dueRearmSql): the fixed day's last instant in
    // the workspace zone, to the millisecond, as the reconcile and the
    // re-confirmation cycle write it, so a person asked again on a fixed-date
    // policy is due when their colleagues are.
    const timeZone = (await getSetting("timezone"))?.trim() || "UTC";
    const fixed = await pool().query<{ due_at: string }>(
      "SELECT due_at FROM policy_assignments WHERE document_id = $1 AND user_id = $2",
      [ahead.id, readerA]
    );
    assert.equal(fixed.rows[0].due_at, endOfDayIn(dayOffset(10), timeZone)!.toISOString(), "the fixed date still ahead is the deadline: its last instant in the workspace zone");

    const past = await newPolicy("fixed past");
    await setDueRule(past.id, { due_days: 3, due_at: dayOffset(-1) });
    await assign(past.id, readerA, { dueAt: daysAgo(20) });
    const fell = await claimReconfirmation(null, past.id, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA] });
    assert.equal(fell.claimed, true);
    const relative = await pool().query<{ ok: boolean }>(
      `SELECT (due_at BETWEEN now() + interval '2 days 23 hours' AND now() + interval '3 days 1 hour') AS ok
       FROM policy_assignments WHERE document_id = $1 AND user_id = $2`,
      [past.id, readerA]
    );
    assert.equal(relative.rows[0].ok, true, "a fixed date already past falls back to now + due_days");
  });

  test("exempt, removed and unassigned people are skipped and reported; nobody open means no claim, no row and no notice", async () => {
    const { id, v1 } = await newPolicy("skipped");
    await assign(id, readerA);
    await assign(id, exemptC, { exempt: true });
    await assign(id, removedD, { removed: true });
    await unassign(id, outsiderE);
    await recordAcknowledgement(id, readerA, "", v1);
    const cBefore = await rowOf(id, exemptC);
    const dBefore = await rowOf(id, removedD);

    const r = await claimReconfirmation(null, id, {
      source: "manual",
      reason: REASON,
      actor: manager(),
      userIds: [exemptC, readerA, removedD, outsiderE, readerA],
    });
    assert.equal(r.claimed, true);
    if (!r.claimed) throw new Error("unreachable");
    assert.deepEqual(r.user_ids, [readerA]);
    assert.deepEqual(r.skipped, [exemptC, removedD, outsiderE], "in the order given, deduplicated");
    assert.equal(r.confirmations_reset, 1);
    assert.deepEqual(await rowOf(id, exemptC), cBefore, "an exempt row is not touched");
    assert.deepEqual(await rowOf(id, removedD), dBefore, "a removed row is not touched");
    assert.equal(await rowOf(id, outsiderE), undefined, "nobody is enrolled by a re-ask");
    const [notice] = await pendingAckOutboxFor(id);
    assert.deepEqual(notice.user_ids, [readerA], "only the person re-opened is in the notice");

    // Nobody named has an open row: refused with the ids, nothing written.
    const none = await claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager(), userIds: [exemptC, removedD] });
    assert.deepEqual(none, { claimed: false, last_asked_at: null, skipped: [exemptC, removedD] });
    const empty = await claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager(), userIds: [] });
    assert.deepEqual(empty, { claimed: false, last_asked_at: null, skipped: [] });
    assert.equal((await listAckDecisions(id)).length, 1, "the refusals wrote no ledger row");
    assert.equal((await pendingAckOutboxFor(id)).length, 1, "and queued no notice");

    // The bare statement, as the assignments endpoints reach it.
    assert.deepEqual(await reopenAssignmentsFor(null, id, [readerA, exemptC]), [readerA]);
    assert.deepEqual(await reopenAssignmentsFor(null, id, [exemptC, removedD, outsiderE]), []);
    assert.deepEqual(await reopenAssignmentsFor(null, id, []), []);

    // A document that no longer takes confirmations: refused like the whole-audience path, no ids.
    await setAckRequired(id, false);
    const off = await claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA] });
    assert.deepEqual(off, { claimed: false, last_asked_at: null });
    const gone = await claimReconfirmation(null, -1, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA] });
    assert.deepEqual(gone, { claimed: false, last_asked_at: null });
  });

  test("a rollback leaves the row, the ledger and the queue as they were", async () => {
    const { id, v1 } = await newPolicy("rollback");
    await assign(id, readerA);
    await recordAcknowledgement(id, readerA, "", v1);
    const before = await rowOf(id, readerA);
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const r = await claimReconfirmation(client, id, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA] });
      assert.equal(r.claimed, true);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.deepEqual(await rowOf(id, readerA), before);
    assert.equal(await currentByCycle(id, readerA), true);
    assert.equal((await listAckDecisions(id)).length, 0);
    assert.equal((await pendingAckOutboxFor(id)).length, 0);
  });

  test("only the people named are told, in the manual re-ask wording with the reason as the body", async () => {
    const { id, title, v1 } = await newPolicy("notice");
    for (const u of [readerA, readerB]) {
      await assign(id, u);
      await recordAcknowledgement(id, u, "", v1);
    }
    const r = await claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager(), userIds: [readerA], origin: ORIGIN });
    assert.equal(r.claimed, true);
    if (!r.claimed) throw new Error("unreachable");
    await drainUntil(async () => Boolean((await getAckOutboxRow(r.outbox_id))?.done_at), `row ${r.outbox_id} delivered`);

    const notices = (await listAckNotices({ documentId: id })).filter((n) => n.outbox_id === r.outbox_id);
    assert.deepEqual(
      notices.map((n) => n.user_id),
      [readerA],
      "the explicit list reaches that person and nobody else"
    );
    assert.equal(notices[0].kind, "updated");
    assert.equal(notices[0].by_user_id, managerId);
    assert.ok(notices[0].channels.includes("inapp"));
    const inbox = await pool().query<{ body: string; link: string }>(
      "SELECT body, link FROM notifications WHERE user_id = $1 AND kind = 'ack_requested' AND title = $2 ORDER BY id",
      [readerA, `Please re-confirm "${title}"`]
    );
    assert.deepEqual(
      inbox.rows.map((x) => [x.body, x.link]),
      [[REASON, `/doc/${id}#confirm-reading`]],
      "B3's manual re-ask wording: the reason is the body"
    );
    const bInbox = await pool().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'ack_requested' AND title = $2",
      [readerB, `Please re-confirm "${title}"`]
    );
    assert.equal(bInbox.rows[0].n, 0, "the other person hears nothing");

    const row = (await getAckOutboxRow(r.outbox_id))!;
    assert.equal(row.noticed, 1);
    assert.equal(row.error, null);
    const audited = await auditRows("ack.reset_notified", id);
    assert.equal(audited.length, 1);
    assert.equal(audited[0].details.pending, 1, "the recipients were the list, not the audience");
    assert.equal(audited[0].details.outbox_id, r.outbox_id);
    const [d] = await listAckDecisions(id);
    assert.ok(d.notified_at, "the ledger row is stamped once the notice went out");
  });

  test("the whole-audience path is unchanged: no list moves the marker, scope 'all', the notice names nobody", async () => {
    const { id, v1 } = await newPolicy("everyone");
    for (const u of [readerA, readerB]) {
      await assign(id, u);
      await recordAcknowledgement(id, u, "", v1);
    }
    const before = await marker(id);
    const r = await claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager() });
    assert.equal(r.claimed, true);
    if (!r.claimed) throw new Error("unreachable");
    assert.equal(r.scope, "all");
    assert.deepEqual(r.user_ids, []);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.asked_at, r.marker);
    assert.equal(r.confirmations_reset, 2);
    const after = await marker(id);
    assert.notEqual(after.at, before.at, "the marker moved");
    assert.ok(after.reminded, "and the cooldown is stamped");
    assert.equal(await getCurrentAck(id, readerA), undefined);
    assert.equal(await getCurrentAck(id, readerB), undefined);
    const [d] = await listAckDecisions(id);
    assert.equal(d.scope, "all");
    assert.equal(d.confirmations_affected, 2);
    assert.equal((await ackSummary(id)).last_decision?.id, d.id);
    const [notice] = await pendingAckOutboxFor(id);
    assert.equal(notice.user_ids, null);
  });

  test("the one-hour brake is per person: two asks of the same person at once take the hour once, a later one re-opens nothing and reports them; a row in its first cycle is never held; the hour lifts", async () => {
    const { id, v1 } = await newPolicy("brake");
    for (const u of [readerA, readerB]) {
      await assign(id, u);
      await recordAcknowledgement(id, u, "", v1);
    }
    // Two asks of the same person in the same second: the document row lock
    // serialises them, and the second sees the first's cycle stamp.
    const ask = (userIds: number[]) => claimReconfirmation(null, id, { source: "manual", reason: REASON, actor: manager(), userIds });
    const [x, y] = await Promise.all([ask([readerA]), ask([readerA])]);
    const won = [x, y].filter((r) => r.claimed);
    assert.equal(won.length, 1, `one of the two asked: ${JSON.stringify([x, y])}`);
    const lost = [x, y].find((r) => !r.claimed)!;
    if (lost.claimed) throw new Error("unreachable");
    assert.deepEqual(lost.cooldown, [readerA], "the person held by the hour");
    assert.deepEqual(lost.skipped, [readerA]);
    assert.ok(lost.last_asked_at && Date.now() - new Date(lost.last_asked_at).getTime() < 10_000, "the stamp that refused it is the first ask's");
    assert.equal((await listAckDecisions(id)).length, 1, "one ledger row");
    assert.equal((await pendingAckOutboxFor(id)).length, 1, "one notice");
    assert.equal(await currentByCycle(id, readerA), false, "asked once");
    if (!won[0].claimed) throw new Error("unreachable");
    assert.deepEqual(won[0].cooldown, [], "nothing held the winner");

    // Straight after: the same refusal, nothing written. With a person in
    // their first cycle beside them, that person is asked and the held one
    // comes back in skipped and in cooldown.
    const again = await ask([readerA]);
    assert.equal(again.claimed, false);
    if (again.claimed) throw new Error("unreachable");
    assert.deepEqual([again.cooldown, again.skipped], [[readerA], [readerA]]);
    const mixed = await ask([readerA, readerB]);
    assert.equal(mixed.claimed, true);
    if (!mixed.claimed) throw new Error("unreachable");
    assert.deepEqual([mixed.user_ids, mixed.skipped, mixed.cooldown], [[readerB], [readerA], [readerA]]);
    assert.equal((await listAckDecisions(id)).length, 2);
    assert.equal((await pendingAckOutboxFor(id)).length, 2);

    // A row whose stamp is the marker (a fresh reconcile row) or older than
    // its assignment (a migrated row) is in its first cycle and never held,
    // however recent: a person who confirmed in three seconds can be asked
    // again at once.
    await pool().query(
      `UPDATE policy_assignments pa SET cycle_started_at = d.ack_revision_at
         FROM documents d WHERE d.id = pa.document_id AND pa.document_id = $1 AND pa.user_id = $2`,
      [id, readerB]
    );
    const fresh = await ask([readerB]);
    assert.equal(fresh.claimed, true, "a first-cycle row is asked at once");
    await pool().query("UPDATE policy_assignments SET cycle_started_at = assigned_at - interval '30 days' WHERE document_id = $1 AND user_id = $2", [id, readerB]);
    assert.equal((await ask([readerB])).claimed, true, "a migrated-shape row too");

    // The bare statement has no brake unless asked for it; with it, the held
    // row is left alone. An hour later the brake lifts.
    assert.deepEqual(await reopenAssignmentsFor(null, id, [readerA], { cooldown: true }), [], "held");
    assert.deepEqual(await reopenAssignmentsFor(null, id, [readerA]), [readerA], "the bare statement re-opens it");
    await pool().query("UPDATE policy_assignments SET cycle_started_at = now() - interval '61 minutes' WHERE document_id = $1 AND user_id = $2", [id, readerA]);
    const later = await ask([readerA]);
    assert.equal(later.claimed, true, "an hour later the person can be asked again");
    if (!later.claimed) throw new Error("unreachable");
    assert.deepEqual([later.user_ids, later.cooldown], [[readerA], []]);
  });
});

// --- The route -----------------------------------------------------------------------

describe("POST /api/documents/[id]/ack/reconfirm with user_ids", () => {
  test("validates the list, answers who was asked and who was skipped, audits the list, and takes no hour", async () => {
    const route = await import("../src/app/api/documents/[id]/ack/reconfirm/route");
    const post = (id: number, body: unknown) =>
      call(route.POST as Handler, sessionRequest(`http://localhost/api/documents/${id}/ack/reconfirm`, managerSession, body), id);

    const { id, v1 } = await newPolicy("route");
    for (const u of [readerA, readerB]) {
      await assign(id, u);
      await recordAcknowledgement(id, u, "", v1);
    }
    await assign(id, exemptC, { exempt: true });
    await assign(id, removedD, { removed: true });
    const before = await marker(id);

    // The reason rule comes first, as for everyone.
    const short = await post(id, { reason: "short", user_ids: [readerA] });
    assert.equal(short.status, 400);
    assert.equal(short.body.error, "A reason of at least 10 characters is required.");

    // The list: a list of positive integers, one to two hundred.
    for (const bad of ["x", { a: 1 }, [1.5], [0], [-1], ["1"], [null]]) {
      const res = await post(id, { reason: REASON, user_ids: bad });
      assert.equal(res.status, 400, `refused: ${JSON.stringify(bad)}`);
      assert.equal(res.body.error, "user_ids must be a list of user ids.");
    }
    const empty = await post(id, { reason: REASON, user_ids: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "Choose at least one person.");
    const many = await post(id, { reason: REASON, user_ids: Array.from({ length: 201 }, (_, i) => 100_000 + i) });
    assert.equal(many.status, 400);
    assert.equal(many.body.error, "Ask up to 200 people at a time.");
    const dup = await post(id, { reason: REASON, user_ids: Array.from({ length: 201 }, () => exemptC) });
    assert.equal(dup.body.error, "This person isn't asked to confirm this document.", "duplicates collapse before the cap");
    assert.deepEqual(dup.body.skipped, [exemptC]);
    const nobody = await post(id, { reason: REASON, user_ids: [exemptC, removedD] });
    assert.equal(nobody.status, 400);
    assert.equal(nobody.body.error, "None of these people are asked to confirm this document.");
    assert.deepEqual(nobody.body.skipped, [exemptC, removedD]);
    assert.equal((await auditRows("ack.reconfirmation_requested", id)).length, 0, "none of the refusals is on the record");
    assert.equal((await listAckDecisions(id)).length, 0);

    // A real list: the person is asked, the exempt one is reported, the marker stays.
    const ok = await post(id, { reason: REASON, user_ids: [readerA, exemptC, readerA] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { ok: true, reset: 1, queued: 1, user_ids: [readerA], skipped: [exemptC] });
    assert.deepEqual(await marker(id), before);
    assert.equal(await currentByCycle(id, readerA), false);
    assert.equal(await currentByCycle(id, readerB), true);
    const audited = await auditRows("ack.reconfirmation_requested", id);
    assert.equal(audited.length, 1);
    assert.equal(audited[0].actor_id, managerId);
    assert.equal(audited[0].details.scope, "users");
    assert.deepEqual(audited[0].details.user_ids, [readerA]);
    assert.deepEqual(audited[0].details.skipped, [exemptC]);
    assert.equal(audited[0].details.reset, 1);
    assert.equal(audited[0].details.queued, 1);
    assert.equal(audited[0].details.reason, REASON);
    assert.equal(audited[0].details.version_id, v1);
    assert.equal(audited[0].details.source, "manual");

    // The whole-audience ask straight after: the per-person one took no hour.
    // `queued` is everyone pending after the reset, which is the whole
    // audience: the switch-on enrolled the manager and everyone else who
    // sees the space, not only the two readers.
    const eligible = (await ackSummary(id)).eligible;
    const everyone = await post(id, { reason: "Section 4 now applies to contractors too" });
    assert.equal(everyone.status, 200, JSON.stringify(everyone.body));
    assert.equal(everyone.body.reset, 1, "only readerB was current: readerA lapsed with the per-person ask");
    assert.equal(everyone.body.queued, eligible, "queued is the whole audience");
    assert.ok(eligible >= 2, "the two readers at least");
    assert.equal(everyone.body.user_ids, undefined, "the whole-audience answer is as it was");
    assert.notEqual((await marker(id)).at, before.at);
    const all = await auditRows("ack.reconfirmation_requested", id);
    assert.equal(all.length, 2);
    assert.equal(all[1].details.scope, "all");
    assert.equal(all[1].details.user_ids, null, "the column is always there");
    assert.equal(all[1].details.skipped, null);
    // A null list reads as everyone too, and is now inside the hour.
    const nul = await post(id, { reason: "Asking everyone again straight away", user_ids: null });
    assert.equal(nul.status, 429);
  });

  test("answers 429 with the person's name when everyone who could have been asked was asked again within the hour, else 200 with them in skipped", async () => {
    const route = await import("../src/app/api/documents/[id]/ack/reconfirm/route");
    const post = (id: number, body: unknown) =>
      call(route.POST as Handler, sessionRequest(`http://localhost/api/documents/${id}/ack/reconfirm`, managerSession, body), id);

    const { id, v1 } = await newPolicy("route brake");
    for (const u of [readerA, readerB]) {
      await assign(id, u);
      await recordAcknowledgement(id, u, "", v1);
    }
    const first = await post(id, { reason: REASON, user_ids: [readerA] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { ok: true, reset: 1, queued: 1, user_ids: [readerA], skipped: [] });

    // The double submit: refused by name, nothing written.
    const second = await post(id, { reason: REASON, user_ids: [readerA] });
    assert.equal(second.status, 429, JSON.stringify(second.body));
    assert.equal(second.body.error, "Reask reader-a was asked again 1 minute ago.");
    assert.deepEqual(second.body.skipped, [readerA]);
    assert.equal((await listAckDecisions(id)).length, 1, "one ledger row");
    assert.equal((await pendingAckOutboxFor(id)).length, 1, "one notice");
    assert.equal((await auditRows("ack.reconfirmation_requested", id)).length, 1, "the refusal is not on the record");

    // Someone else beside the held person: 200, the held one in skipped,
    // and the audit row says who was held.
    const both = await post(id, { reason: REASON, user_ids: [readerA, readerB] });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual(both.body, { ok: true, reset: 1, queued: 1, user_ids: [readerB], skipped: [readerA] });
    const audited = await auditRows("ack.reconfirmation_requested", id);
    assert.equal(audited.length, 2);
    assert.deepEqual(audited[1].details.skipped, [readerA]);
    assert.deepEqual(audited[1].details.cooldown, [readerA]);

    // Both held: the plural sentence. A held person beside an exempt one:
    // the hour is the reason nobody was asked, so 429 rather than "not asked".
    const two = await post(id, { reason: REASON, user_ids: [readerA, readerB] });
    assert.equal(two.status, 429);
    assert.equal(two.body.error, "These people were asked again 1 minute ago.");
    await assign(id, exemptC, { exempt: true });
    const mixed = await post(id, { reason: REASON, user_ids: [readerA, exemptC] });
    assert.equal(mixed.status, 429);
    assert.equal(mixed.body.error, "Reask reader-a was asked again 1 minute ago.");
    assert.deepEqual(mixed.body.skipped, [readerA, exemptC]);
    assert.equal((await listAckDecisions(id)).length, 2, "still two ledger rows");
  });
});

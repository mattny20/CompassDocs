// Retire a policy (G3, 1.12.0): an end-of-life state beside `status` that
// keeps the evidence. retirePolicy switches the requirement off and stamps
// who, when and why in one UPDATE guarded on the policy not being retired
// already, leaves the marker alone, cancels the policy's queued notices and
// writes the 'retired' ledger row with the counts frozen at that moment.
// A retired policy is out of the request picker and of everyone's pending
// list, stays in complianceDocs as a retired row (last, with the frozen
// counts), and is never auto-purged from the Trash once it has
// confirmations. unretirePolicy clears the retirement and switches the
// requirement back on with the prior confirmations current, unless the text
// changed while it was retired (the silent marker advance makes them stale,
// so nobody is shown as 100% for words they never read). setSupersededBy
// validates the replacement.
//
// The routes (403 for a program_read-only role, 400 for a short reason, 409
// on a second retire and on PATCH /ack { required: true } of a retired
// policy, the DocNotices row and the card's return on un-retire) need the
// licence and run on the licensed rig: e2e/compliance-rbac.spec.ts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-retire.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { asScope } from "../src/lib/space-scope";
import {
  pool,
  getSetting,
  createDocument,
  getDocument,
  updateDocument,
  setAckRequired,
  recordAcknowledgement,
  getCurrentAck,
  listVersions,
  listAckDecisions,
  insertAckOutbox,
  pendingAckOutboxFor,
  retirePolicy,
  unretirePolicy,
  setSupersededBy,
  listRetiredPolicies,
  complianceDocs,
  ackCandidateDocs,
  listPendingAcksFor,
  ackSummary,
  deleteDocument,
  purgeExpiredTrash,
  listTrashedDocuments,
  ACK_OUTBOX_CANCELLED_RETIRED,
} from "../src/lib/db";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackretire-${Date.now()}`;

let spaceId = 0;
let readerId = 0;
let otherId = 0;
let managerId = 0;
const docIds: number[] = [];

const TEXT = Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);
const REASON = "Superseded by the new expense policy";
const manager = () => ({ id: managerId, name: "Mia Manager" });

const marker = (id: number) =>
  pool()
    .query("SELECT ack_revision_at::text AS at, ack_version_id FROM documents WHERE id = $1", [id])
    .then((r) => r.rows[0]);

/** A published policy; with `confirm` (the default) the reader has confirmed its first version. */
async function policy(title: string, opts: { confirm?: boolean; status?: "published" | "draft" } = {}): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: opts.status ?? "published",
    content: TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  // Both null: leave the edit default and the interval columns alone rather
  // than read the workspace settings row, which another test file may be
  // writing (a default interval there would give the fixture a cycle).
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
  const v1 = (await listVersions(doc.id))[0].id;
  if (opts.confirm !== false) await recordAcknowledgement(doc.id, readerId, "", v1);
  return { id: doc.id, v1 };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Retire ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Ret Reader', $2, 'viewer', 'active'),
       ($3, 'Ret Other', $4, 'viewer', 'active'),
       ($5, 'Mia Manager', $6, 'approver', 'active')
     RETURNING id`,
    [
      `${STAMP}-reader`,
      `${STAMP}-reader@example.test`,
      `${STAMP}-other`,
      `${STAMP}-other@example.test`,
      `${STAMP}-manager`,
      `${STAMP}-manager@example.test`,
    ]
  );
  readerId = users.rows[0].id;
  otherId = users.rows[1].id;
  managerId = users.rows[2].id;
});

after(async () => {
  const userIds = [readerId, otherId, managerId];
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("retire freezes the record and stops asking", () => {
  test("one UPDATE switches the requirement off and stamps the retirement; the marker stays; the counts are frozen on a 'retired' ledger row; a second retire is refused", async () => {
    const { id, v1 } = await policy(`${STAMP} freeze`);
    const before = await marker(id);

    const r = await retirePolicy(id, manager(), REASON);
    assert.ok(r, "the first call retires");
    assert.equal(r.title, `${STAMP} freeze`);
    assert.equal(r.acked, 1, "the reader's confirmation was current");
    // The audience is every active account that can see an internal space,
    // which in the shared database is at least this file's three.
    assert.ok(r.required >= 3, `the audience as it stood (${r.required})`);
    assert.equal(r.version_id, v1, "the version people had been asked to confirm");
    assert.equal(r.rev, 1);
    assert.equal(r.superseded_by, null);
    assert.equal(r.cancelled, 0, "nothing was queued");
    assert.ok(r.decision_id > 0);

    const doc = (await getDocument(id))!;
    assert.equal(doc.ack_required, 0, "the policy asks nobody");
    assert.ok(doc.ack_retired_at, "stamped");
    assert.equal(doc.ack_retired_by_name, "Mia Manager");
    assert.equal(doc.ack_retired_reason, REASON);
    assert.equal(new Date(doc.ack_retired_at!).toISOString(), new Date(r.retired_at).toISOString());
    assert.deepEqual(await marker(id), before, "ack_revision_at and ack_version_id are untouched");
    assert.ok(await getCurrentAck(id, readerId), "the confirmation is still on record, and still current against the marker");
    const summary = await ackSummary(id);
    assert.equal(summary.required, false);
    assert.equal(summary.current, 1, "the record reads as it did");

    const rows = await listAckDecisions(id);
    assert.equal(rows.length, 1, "one ledger row: the retirement");
    const [row] = rows;
    assert.equal(row.id, r.decision_id);
    assert.equal(row.outcome, "retired");
    assert.equal(row.source, "manual");
    assert.equal(row.reason, REASON);
    assert.equal(row.decided_by, managerId);
    assert.equal(row.decided_by_name, "Mia Manager");
    assert.equal(row.version_id, v1);
    assert.equal(row.rev, 1);
    assert.equal(row.confirmations_affected, 1, "acked, frozen");
    assert.equal(row.eligible, r.required, "required, frozen");
    assert.equal(new Date(row.decided_at).toISOString(), new Date(r.retired_at).toISOString(), "the row and the column carry one stamp");

    assert.equal(await retirePolicy(id, manager(), "Retiring it a second time"), null, "already retired: no row, no change");
    assert.equal((await listAckDecisions(id)).length, 1, "no second ledger row");
    assert.equal((await getDocument(id))!.ack_retired_reason, REASON, "the first reason stands");
  });

  test("queued notices for the policy are cancelled in the same transaction; a row a drain has claimed is left to it", async () => {
    const { id } = await policy(`${STAMP} outbox`);
    const actor = manager();
    const queued = await insertAckOutbox(null, { document_id: id, mode: "reminder", source: "manual", actor, user_ids: null });
    const claimed = await insertAckOutbox(null, { document_id: id, mode: "updated", source: "manual", actor, user_ids: null });
    await pool().query("UPDATE ack_outbox SET claimed_at = now(), attempts = 1 WHERE id = $1", [claimed]);
    assert.equal((await pendingAckOutboxFor(id)).length, 2);

    const r = await retirePolicy(id, actor, REASON);
    assert.ok(r);
    assert.equal(r.cancelled, 1, "the unclaimed row was cancelled");
    const left = await pendingAckOutboxFor(id);
    assert.deepEqual(left.map((o) => o.id), [claimed], "the claimed row is still the drain's");
    const cancelled = await pool().query("SELECT done_at, error, claimed_at FROM ack_outbox WHERE id = $1", [queued]);
    assert.ok(cancelled.rows[0].done_at, "finished, as the drain reads it");
    assert.equal(cancelled.rows[0].error, ACK_OUTBOX_CANCELLED_RETIRED);
    assert.equal(cancelled.rows[0].claimed_at, null, "never claimed");
  });

  test("a retired policy is out of the request picker and of everyone's pending list, and in complianceDocs as a retired row, last, with the frozen counts", async () => {
    const live = await policy(`${STAMP} still live`, { confirm: false });
    const { id, v1 } = await policy(`${STAMP} retired row`);
    const scope = asScope([spaceId]);
    assert.ok((await listPendingAcksFor(otherId, scope)).some((d) => d.id === id), "before: the other reader owes it");
    assert.ok(!(await ackCandidateDocs()).some((d) => d.id === id), "before: a required policy is no candidate");

    const r = await retirePolicy(id, manager(), REASON);
    assert.ok(r);
    assert.ok(!(await listPendingAcksFor(otherId, scope)).some((d) => d.id === id), "after: nobody owes it");
    assert.ok(!(await listPendingAcksFor(readerId, scope)).some((d) => d.id === id));
    assert.ok(!(await ackCandidateDocs()).some((d) => d.id === id), "after: the requirement is off, but it is no candidate either");

    const docs = await complianceDocs();
    const mine = docs.find((d) => d.id === id);
    assert.ok(mine, "still listed");
    assert.ok(mine.ack_retired_at, "as retired");
    assert.equal(mine.ack_retired_by_name, "Mia Manager");
    assert.equal(mine.ack_retired_reason, REASON);
    assert.equal(mine.ack_superseded_by, null);
    assert.equal(mine.superseded_by_title, null);
    assert.equal(mine.acked, r.acked, "the frozen count");
    assert.equal(mine.required, r.required);
    assert.equal(mine.retired_rev, 1, "the version people had been asked to confirm");
    assert.equal(mine.ack_version_id, v1);
    assert.equal(mine.last_decision?.outcome, "retired");
    assert.equal(mine.last_decision?.reason, REASON);
    const firstRetired = docs.findIndex((d) => d.ack_retired_at !== null);
    assert.ok(firstRetired >= 0);
    assert.ok(docs.slice(firstRetired).every((d) => d.ack_retired_at !== null), "every retired row sorts after every live one");
    assert.ok(docs.findIndex((d) => d.id === live.id) < docs.findIndex((d) => d.id === id), "the live policy from this file comes first");
    const liveRow = docs.find((d) => d.id === live.id)!;
    assert.equal(liveRow.ack_retired_at, null);
    assert.equal(liveRow.retired_rev, null);
    assert.ok((await listRetiredPolicies()).some((d) => d.id === id), "listRetiredPolicies has it");
    assert.ok(!(await listRetiredPolicies()).some((d) => d.id === live.id));
  });
});

describe("un-retire resumes the policy", () => {
  test("the retirement is cleared and the requirement switches back on with the prior confirmations current; a second un-retire is refused", async () => {
    const { id, v1 } = await policy(`${STAMP} resume`);
    const replacement = await policy(`${STAMP} replacement`, { confirm: false });
    const set = await setSupersededBy(id, replacement.id);
    assert.ok(set.ok);
    const r = await retirePolicy(id, manager(), REASON);
    assert.ok(r);
    assert.equal(r.superseded_by, replacement.id, "the replacement set beforehand is on the result");
    assert.equal((await complianceDocs()).find((d) => d.id === id)?.superseded_by_title, `${STAMP} replacement`);

    const u = await unretirePolicy(id);
    assert.ok(u, "resumed");
    assert.equal(u.title, `${STAMP} resume`);
    assert.equal(u.current, 1, "the reader's confirmation counts again");
    assert.ok(u.eligible >= 3);
    const doc = (await getDocument(id))!;
    assert.equal(doc.ack_required, 1);
    assert.equal(doc.ack_retired_at, null);
    assert.equal(doc.ack_retired_by_name, "");
    assert.equal(doc.ack_retired_reason, "");
    assert.equal(doc.ack_superseded_by, null, "a policy that is live again is not replaced by anything");
    assert.equal((await marker(id)).ack_version_id, v1, "the marker never moved");
    assert.ok(await getCurrentAck(id, readerId));
    assert.equal((await ackSummary(id)).required, true);
    assert.equal((await listAckDecisions(id)).length, 1, "un-retire writes no ledger row: nothing was asked of anyone");
    assert.ok(!(await complianceDocs()).find((d) => d.id === id)?.ack_retired_at, "listed as live again");

    assert.equal(await unretirePolicy(id), null, "not retired: refused");
    assert.equal(await unretirePolicy(-1), null);
  });

  test("edits while retired advance the marker, so un-retire asks again instead of showing 100% for unread text", async () => {
    const { id, v1 } = await policy(`${STAMP} edited while retired`);
    assert.ok(await retirePolicy(id, manager(), REASON));
    const editor = { id: managerId, name: "Mia Manager" };
    const saved = await updateDocument(id, {
      content: `${TEXT}\n\nClause 31: contractors are covered too.`,
      versionNote: "Extended to contractors while retired",
      ackActor: editor,
      ackSource: "edit",
    });
    assert.ok(saved);
    const v2 = (await listVersions(id))[0].id;
    assert.notEqual(v2, v1, "the edit wrote a version");
    assert.equal((await marker(id)).ack_version_id, v2, "the requirement is off: the marker followed the text silently");
    assert.equal((await listAckDecisions(id)).filter((d) => d.outcome !== "retired").length, 0, "no decision row: nobody was asked");
    assert.equal(await getCurrentAck(id, readerId), undefined, "the old confirmation is stale");

    const u = await unretirePolicy(id);
    assert.ok(u);
    assert.equal(u.current, 0, "nobody has confirmed the text that is live now");
    assert.equal((await getDocument(id))!.ack_required, 1);
    assert.ok((await listPendingAcksFor(readerId, asScope([spaceId]))).some((d) => d.id === id), "the reader is asked again");
    const retiredRow = (await listAckDecisions(id)).find((d) => d.outcome === "retired")!;
    assert.equal(retiredRow.version_id, v1, "the ledger still says which version the record was frozen on");
  });

  test("an unpublished policy resumes as Paused", async () => {
    const { id } = await policy(`${STAMP} paused resume`, { status: "draft" });
    assert.ok(await retirePolicy(id, manager(), REASON), "a paused policy can be retired");
    const u = await unretirePolicy(id);
    assert.ok(u);
    const doc = (await getDocument(id))!;
    assert.equal(doc.status, "draft");
    assert.equal(doc.ack_required, 1, "paused: the requirement is on while the document is down");
    const row = (await complianceDocs()).find((d) => d.id === id)!;
    assert.equal(row.status, "draft");
    assert.equal(row.ack_retired_at, null);
  });
});

describe("the replacement", () => {
  test("setSupersededBy takes a published, live document other than the policy itself, inside the caller's scope, or null", async () => {
    const { id } = await policy(`${STAMP} superseded`, { confirm: false });
    const target = await policy(`${STAMP} target`, { confirm: false });
    const draft = await createDocument({
      space_id: spaceId,
      title: `${STAMP} draft target`,
      type: "policy",
      status: "draft",
      content: TEXT,
      summary: "",
      tags: [],
      author: "test",
    });
    docIds.push(draft.id);

    const self = await setSupersededBy(id, id);
    assert.equal(self.ok, false);
    assert.equal(!self.ok && self.error, "A policy cannot be replaced by itself.");
    const toDraft = await setSupersededBy(id, draft.id);
    assert.equal(toDraft.ok, false, "a draft is not a published document");
    assert.equal((await setSupersededBy(id, 2_000_000_000)).ok, false, "a missing document");
    assert.equal((await setSupersededBy(id, 0)).ok, false, "not an id");
    assert.equal((await setSupersededBy(id, 1.5)).ok, false);
    const outOfScope = await setSupersededBy(id, target.id, asScope([]));
    assert.equal(outOfScope.ok, false, "a document outside the caller's scope");
    assert.equal((await getDocument(id))!.ack_superseded_by, null, "nothing was written by a refusal");

    const set = await setSupersededBy(id, target.id, asScope([spaceId]));
    assert.ok(set.ok);
    assert.equal(set.from, null);
    assert.equal(set.to, target.id);
    assert.equal(set.to_title, `${STAMP} target`);
    assert.equal((await getDocument(id))!.ack_superseded_by, target.id);

    const cleared = await setSupersededBy(id, null);
    assert.ok(cleared.ok);
    assert.equal(cleared.from, target.id);
    assert.equal(cleared.to, null);
    assert.equal(cleared.to_title, null);
    assert.equal((await getDocument(id))!.ack_superseded_by, null);

    const gone = await setSupersededBy(-1, null);
    assert.equal(gone.ok, false);
  });

  test("a trashed replacement drops out of the portal's title without losing the id", async () => {
    const { id } = await policy(`${STAMP} orphaned replacement`, { confirm: false });
    const target = await policy(`${STAMP} trashed target`, { confirm: false });
    assert.ok((await setSupersededBy(id, target.id)).ok);
    assert.ok(await retirePolicy(id, manager(), REASON));
    assert.equal(await deleteDocument(target.id), true);
    const row = (await complianceDocs()).find((d) => d.id === id)!;
    assert.equal(row.ack_superseded_by, target.id, "the column keeps the id (ON DELETE SET NULL fires only on a purge)");
    assert.equal(row.superseded_by_title, null, "but no title is offered for a document in the Trash");
  });
});

describe("the Trash keeps the evidence", () => {
  test("purgeExpiredTrash skips a trashed document with confirmations and purges one without; the listing carries the count and the retirement", async () => {
    const kept = await policy(`${STAMP} trash kept`);
    assert.ok(await retirePolicy(kept.id, manager(), REASON));
    const plain = await createDocument({
      space_id: spaceId,
      title: `${STAMP} trash plain`,
      type: "knowledge",
      status: "published",
      content: "Nothing to confirm here.",
      summary: "",
      tags: [],
      author: "test",
    });
    docIds.push(plain.id);
    assert.equal(await deleteDocument(kept.id), true, "trashing a retired policy is allowed");
    assert.equal(await deleteDocument(plain.id), true);
    await pool().query("UPDATE documents SET deleted_at = now() - interval '40 days' WHERE id = ANY($1)", [[kept.id, plain.id]]);

    const listed = await listTrashedDocuments({ q: `${STAMP} trash` });
    const keptRow = listed.rows.find((r) => r.id === kept.id);
    const plainRow = listed.rows.find((r) => r.id === plain.id);
    assert.ok(keptRow && plainRow, "both are in the Trash");
    assert.equal(keptRow.ack_count, 1);
    assert.ok(keptRow.ack_retired_at, "the retirement travels with the row");
    assert.equal(plainRow.ack_count, 0);
    assert.equal(plainRow.ack_retired_at, null);

    // No assertion on the count: test/ack-retention.test.ts sweeps the same
    // Trash in parallel and may purge this file's expired document first.
    // The rows below prove the sweep ran.
    await purgeExpiredTrash(30);
    const after = await pool().query("SELECT id FROM documents WHERE id = ANY($1) ORDER BY id", [[kept.id, plain.id]]);
    assert.deepEqual(after.rows.map((r) => r.id), [kept.id], "the policy with a record stays; the plain document is gone");
    const record = await pool().query("SELECT COUNT(*)::int AS n FROM acknowledgements WHERE document_id = $1", [kept.id]);
    assert.equal(record.rows[0].n, 1, "and its confirmation is intact");
    assert.ok((await listTrashedDocuments({ q: `${STAMP} trash` })).rows.some((r) => r.id === kept.id), "still listed in the Trash");
  });
});

// My policies (B4, 1.12.0): what one person is asked to confirm, read four
// ways from one document predicate. listMyPolicies lists every policy in
// the person's scope with where they stand ('pending', 'reconfirm',
// 'confirmed'), to-confirm rows first and then the most recently asked;
// countPendingAcksFor is the sidebar badge and equals the pending rows;
// listPendingAcksFor (the dashboard row, unlimited since 1.12.0) names the
// same documents; hasPolicyInScope is the nav gate, one EXISTS over the
// person's space scope. A paused policy (unpublished), a retired one
// (ack_retired_at set), a trashed one and one outside the scope are absent
// from all four.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/my-policies.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  createDocument,
  updateDocument,
  setAckRequired,
  recordAcknowledgement,
  listVersions,
  listMyPolicies,
  listPendingAcksFor,
  countPendingAcksFor,
  hasPolicyInScope,
} from "../src/lib/db";
import { asScope } from "../src/lib/space-scope";
import { fixtureQuery } from "./support/retry";

const STAMP = `mypol-${Date.now()}`;

let spaceId = 0;
let otherSpaceId = 0;
let emptySpaceId = 0;
let readerId = 0;
let editorId = 0;
const docIds: number[] = [];

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newPolicy(title: string, space = spaceId): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: space,
    title,
    type: "policy",
    status: "published",
    content: LONG_TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  await setAckRequired(doc.id, true, { editDefault: null });
  docIds.push(doc.id);
  return { id: doc.id, v1: (await listVersions(doc.id))[0].id };
}

/** A material change through the editor's API path: the marker moves and every confirmation lapses. */
async function reset(id: number, suffix: string): Promise<number> {
  await updateDocument(id, {
    content: `${LONG_TEXT}\n\n${suffix}`,
    ackPolicy: "reset",
    ackReason: "Cap raised; everyone must read the new figure",
    ackActor: { id: editorId, name: "My Policies Editor" },
    ackSource: "edit",
  });
  return (await listVersions(id))[0].id;
}

const mine = (scope = asScope([spaceId])) => listMyPolicies(readerId, scope);

before(async () => {
  await getSetting("__schema_bootstrap__");
  const spaces = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES
       ($1, $2, '📁', '', 'internal'),
       ($3, $4, '📁', '', 'internal'),
       ($5, $6, '📁', '', 'internal')
     RETURNING id`,
    [`My Policies ${STAMP}`, STAMP, `My Policies other ${STAMP}`, `${STAMP}-other`, `My Policies empty ${STAMP}`, `${STAMP}-empty`]
  );
  spaceId = spaces.rows[0].id;
  otherSpaceId = spaces.rows[1].id;
  emptySpaceId = spaces.rows[2].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'My Policies Reader', $2, 'viewer', 'active'),
       ($3, 'My Policies Editor', $4, 'editor', 'active')
     RETURNING id`,
    [`${STAMP}-reader`, `${STAMP}-reader@example.test`, `${STAMP}-editor`, `${STAMP}-editor@example.test`]
  );
  readerId = users.rows[0].id;
  editorId = users.rows[1].id;
});

after(async () => {
  // Only what this file made: its documents' rows, then its documents,
  // users and spaces (never a sweep by user id).
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [
    docIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [[readerId, editorId]]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [[spaceId, otherSpaceId, emptySpaceId]]);
});

describe("listMyPolicies: one person's standing on every policy in scope", () => {
  test("states and order: to-confirm first, newest ask first, then the confirmed ones", async () => {
    const pending = await newPolicy(`${STAMP} pending`);
    const confirmed = await newPolicy(`${STAMP} confirmed`);
    await recordAcknowledgement(confirmed.id, readerId, "", confirmed.v1);
    const reconfirm = await newPolicy(`${STAMP} reconfirm`);
    await recordAcknowledgement(reconfirm.id, readerId, "", reconfirm.v1);
    const v2 = await reset(reconfirm.id, "The cap is now 75.");

    const rows = await mine();
    assert.deepEqual(
      rows.map((r) => r.id),
      [reconfirm.id, pending.id, confirmed.id],
      "the re-ask's marker is the newest, then the never-confirmed one, then the confirmed one"
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const p = byId.get(pending.id)!;
    assert.equal(p.state, "pending");
    assert.equal(p.acknowledged_at, null);
    assert.equal(p.prior_acknowledged_at, null);
    assert.equal(p.rev, null);
    assert.equal(p.title, `${STAMP} pending`);
    assert.equal(p.space_icon, "📁");
    assert.equal(p.space_name, `My Policies ${STAMP}`);
    assert.ok(p.updated_at, "the row carries when the document was last saved");

    const c = byId.get(confirmed.id)!;
    assert.equal(c.state, "confirmed");
    assert.ok(c.acknowledged_at, "the current confirmation's time");
    assert.equal(c.prior_acknowledged_at, null, "no earlier cycle");
    assert.equal(c.rev, 1, "the version the confirmation cites");

    const r = byId.get(reconfirm.id)!;
    assert.equal(r.state, "reconfirm");
    assert.equal(r.acknowledged_at, null, "the lapsed row is not current");
    assert.ok(r.prior_acknowledged_at, "the chip says when they last confirmed");
    assert.equal(r.rev, null);

    // Re-confirming the new text: current again, citing v2, with the lapsed
    // confirmation as the prior one.
    await recordAcknowledgement(reconfirm.id, readerId, "", v2);
    const again = (await mine()).find((x) => x.id === reconfirm.id)!;
    assert.equal(again.state, "confirmed");
    assert.equal(again.rev, 2);
    assert.equal(again.prior_acknowledged_at, r.prior_acknowledged_at, "the previous cycle is still the prior one");
    assert.ok(again.acknowledged_at && again.acknowledged_at > again.prior_acknowledged_at!);
  });

  test("countPendingAcksFor equals the rows listed to confirm, and listPendingAcksFor names the same documents", async () => {
    const rows = await mine();
    const toConfirm = rows.filter((r) => r.state !== "confirmed").map((r) => r.id);
    assert.ok(toConfirm.length >= 1, "the fixture leaves at least one policy to confirm");
    assert.equal(await countPendingAcksFor(readerId, asScope([spaceId])), toConfirm.length);
    const dashboard = await listPendingAcksFor(readerId, asScope([spaceId]));
    assert.deepEqual(
      dashboard.map((d) => d.id).sort(),
      [...toConfirm].sort(),
      "the dashboard row and the badge agree with the page"
    );
    assert.deepEqual(
      dashboard.map((d) => d.id),
      toConfirm,
      "and in the same order: newest ask first"
    );
    // The editor has confirmed nothing: everything is pending for them.
    assert.equal(await countPendingAcksFor(editorId, asScope([spaceId])), rows.length);
  });

  test("hasPolicyInScope respects the space scope", async () => {
    assert.equal(await hasPolicyInScope(readerId, asScope([spaceId])), true);
    assert.equal(await hasPolicyInScope(readerId, asScope("all")), true);
    assert.equal(await hasPolicyInScope(readerId, asScope([emptySpaceId])), false, "a space with no policy");
    assert.equal(await hasPolicyInScope(readerId, asScope([])), false, "no spaces at all");
    // It asks whether a policy is in scope, not whether one is pending: the
    // item must not flicker off once everything is confirmed.
    const confirmedId = (await mine()).find((r) => r.state === "confirmed")!.id;
    const spaceOfConfirmed = (await pool().query("SELECT space_id FROM documents WHERE id = $1", [confirmedId])).rows[0]
      .space_id;
    assert.equal(spaceOfConfirmed, spaceId);
    assert.equal(await hasPolicyInScope(readerId, asScope([spaceId])), true);
  });

  test("a retired policy, a paused one, a trashed one and one outside the scope are absent from all four", async () => {
    const retired = await newPolicy(`${STAMP} retired`, emptySpaceId);
    await recordAcknowledgement(retired.id, readerId, "", retired.v1);
    assert.equal(await hasPolicyInScope(readerId, asScope([emptySpaceId])), true, "live, it counts");
    // Retirement (G3) drops ack_required to 0 as well; the column alone must
    // be enough, so the four readers agree with the recert sweep's WHERE.
    await fixtureQuery("UPDATE documents SET ack_retired_at = now() WHERE id = $1", [retired.id]);
    assert.equal(await hasPolicyInScope(readerId, asScope([emptySpaceId])), false, "retired: nothing to show");
    assert.equal((await mine(asScope([emptySpaceId]))).length, 0, "retired: not listed, confirmed or not");
    assert.equal(await countPendingAcksFor(editorId, asScope([emptySpaceId])), 0, "retired: not counted");
    assert.equal((await listPendingAcksFor(editorId, asScope([emptySpaceId]))).length, 0);
    await fixtureQuery("UPDATE documents SET ack_retired_at = NULL, ack_required = 0 WHERE id = $1", [retired.id]);
    assert.equal(await hasPolicyInScope(readerId, asScope([emptySpaceId])), false, "stopped: nothing to show either");

    const paused = await newPolicy(`${STAMP} paused`, emptySpaceId);
    await fixtureQuery("UPDATE documents SET status = 'draft' WHERE id = $1", [paused.id]);
    assert.equal(await hasPolicyInScope(readerId, asScope([emptySpaceId])), false, "paused: nobody is owed");
    assert.equal((await mine(asScope([emptySpaceId]))).length, 0);
    assert.equal(await countPendingAcksFor(readerId, asScope([emptySpaceId])), 0);

    const trashed = await newPolicy(`${STAMP} trashed`, emptySpaceId);
    await fixtureQuery("UPDATE documents SET deleted_at = now() WHERE id = $1", [trashed.id]);
    assert.equal(await hasPolicyInScope(readerId, asScope([emptySpaceId])), false, "trashed: gone from the list");
    assert.equal((await mine(asScope([emptySpaceId]))).length, 0);

    const elsewhere = await newPolicy(`${STAMP} elsewhere`, otherSpaceId);
    const inScope = await mine();
    assert.ok(!inScope.some((r) => r.id === elsewhere.id), "a policy in a space outside the scope is not listed");
    assert.equal(await countPendingAcksFor(readerId, asScope([spaceId])), inScope.filter((r) => r.state !== "confirmed").length);
    const wider = await mine(asScope([spaceId, otherSpaceId]));
    assert.ok(wider.some((r) => r.id === elsewhere.id), "and appears once the scope includes its space");
    assert.equal(wider.find((r) => r.id === elsewhere.id)!.state, "pending");
    assert.equal(await hasPolicyInScope(readerId, asScope([otherSpaceId])), true);
  });
});

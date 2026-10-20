// My policies (B4, 1.12.0): what one person is asked to confirm, read four
// ways from one document predicate. listMyPolicies lists every policy in
// the person's scope with where they stand ('pending', 'reconfirm',
// 'overdue', 'confirmed'), to-confirm rows first in the person's priority
// (E1, 1.13.0: overdue first, then the soonest deadline, then the most
// recently changed, updated_at being the date each row prints), then the
// confirmed ones; countPendingAcksFor is the sidebar badge and equals the
// pending rows; countOverdueAcksFor is the dashboard's "· 1 overdue";
// listPendingAcksFor (the dashboard row, unlimited since 1.12.0) names the
// same documents in the same order with each deadline; hasPolicyInScope is
// the nav gate, one EXISTS over the person's space scope; getMyAssignment
// is the document page's probe of the reader's own row (the deadline, the
// cycle, the per-person ask that restarted it). A paused policy
// (unpublished), a retired one (ack_retired_at set), a trashed one and one
// outside the scope are absent from all of them.
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
  claimReconfirmation,
  listVersions,
  listMyPolicies,
  listPendingAcksFor,
  countPendingAcksFor,
  countOverdueAcksFor,
  getMyAssignment,
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
  // Both null: leave the edit default and the interval columns alone rather
  // than read the workspace settings row, which another test file may be
  // writing (a default interval there would give the fixture a cycle).
  await setAckRequired(doc.id, true, { editDefault: null, recertMonths: null });
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
  test("states and order: to-confirm first, most recently changed first, then the confirmed ones", async () => {
    const pending = await newPolicy(`${STAMP} pending`);
    const confirmed = await newPolicy(`${STAMP} confirmed`);
    await recordAcknowledgement(confirmed.id, readerId, "", confirmed.v1);
    const reconfirm = await newPolicy(`${STAMP} reconfirm`);
    await recordAcknowledgement(reconfirm.id, readerId, "", reconfirm.v1);
    const v2 = await reset(reconfirm.id, "The cap is now 75.");

    const rows = await mine();
    assert.deepEqual(
      rows.map((r) => r.id),
      [pending.id, reconfirm.id, confirmed.id],
      "to confirm first, the soonest deadline leading (the never-confirmed one was assigned first, so it is due first; the re-asked one keeps its later deadline), then the confirmed one"
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
    assert.ok(p.due_at, "the row carries the person's deadline (E1): the cascade's days from assignment");
    assert.ok(Date.parse(p.due_at!) > Date.now(), "and it is ahead");
    assert.ok(
      Date.parse(p.due_at!) < Date.parse(byId.get(reconfirm.id)!.due_at!),
      "assigned first, due first: the order key"
    );

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
      "and in the same order: the dashboard's three titles are the page's first three (overdue first, then the soonest deadline, then the most recently changed)"
    );
    for (const d of dashboard) {
      assert.ok(d.due_at, "each dashboard row carries the deadline for its '(due …)'");
      assert.equal(d.overdue, false, "nothing is overdue yet");
    }
    assert.equal(await countOverdueAcksFor(readerId, asScope([spaceId])), 0);
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

  test("21 required policies: the badge, the dashboard row (no LIMIT since 1.12.0) and the page agree, and the to-confirm group is ordered by the deadline, then updated_at", async () => {
    const many: number[] = [];
    for (let i = 1; i <= 21; i++) many.push((await newPolicy(`${STAMP} many ${String(i).padStart(2, "0")}`)).id);
    // One deadline for the 21, sooner than the fixture's older policies, so
    // they lead the group and the tie goes to updated_at: the first of them
    // saved again last leads although its ask (ack_revision_at) is the
    // oldest of the 21.
    await fixtureQuery(
      "UPDATE policy_assignments SET due_at = now() + interval '1 day' WHERE document_id = ANY($1) AND user_id = $2",
      [many, readerId]
    );
    await fixtureQuery("UPDATE documents SET updated_at = now() + interval '1 minute' WHERE id = $1", [many[0]]);

    const scope = asScope([spaceId]);
    const count = await countPendingAcksFor(readerId, scope);
    assert.ok(count >= 21, `at least the 21 new policies are pending (${count})`);
    const dashboard = await listPendingAcksFor(readerId, scope);
    assert.equal(dashboard.length, count, "the dashboard row is not capped");
    assert.ok(many.every((id) => dashboard.some((d) => d.id === id)), "all 21 are in the dashboard row");

    const rows = await mine(scope);
    const toConfirm = rows.filter((r) => r.state !== "confirmed");
    assert.equal(toConfirm.length, count, "the page lists every pending policy");
    assert.ok(many.every((id) => rows.some((r) => r.id === id)), "all 21 are on the page");
    assert.deepEqual(
      toConfirm
        .slice(0, 21)
        .map((r) => r.id)
        .sort(),
      [...many].sort(),
      "the 21 with the soonest deadline lead the group"
    );
    assert.equal(toConfirm[0].id, many[0], "among equal deadlines the most recently changed policy leads");
    const times = toConfirm.slice(0, 21).map((r) => Date.parse(r.updated_at));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], `equal deadlines are ordered by updated_at DESC (rows ${i - 1} and ${i})`);
    }
    const dues = toConfirm.map((r) => (r.due_at ? Date.parse(r.due_at) : Number.POSITIVE_INFINITY));
    for (let i = 1; i < dues.length; i++) {
      assert.ok(dues[i - 1] <= dues[i], `the to-confirm group is ordered by the deadline, soonest first (rows ${i - 1} and ${i})`);
    }
    assert.deepEqual(
      dashboard.map((d) => d.id),
      toConfirm.map((r) => r.id),
      "the dashboard row lists them in the page's order"
    );
  });

  test("an overdue policy (E1): state 'overdue', first on the page and the dashboard, counted by countOverdueAcksFor; the policy's or the space's grace delays it; a confirmation ends it", async () => {
    const scope = asScope([spaceId]);
    const late = await newPolicy(`${STAMP} overdue`);
    const backdate = () =>
      fixtureQuery("UPDATE policy_assignments SET due_at = now() - interval '2 days' WHERE document_id = $1 AND user_id = $2", [
        late.id,
        readerId,
      ]);
    assert.equal((await backdate()).rowCount, 1, "the reader's row on the new policy");
    const stateOf = async (userId = readerId) => (await listMyPolicies(userId, scope)).find((r) => r.id === late.id)?.state;

    const rows = await mine(scope);
    const row = rows.find((r) => r.id === late.id)!;
    assert.equal(row.state, "overdue");
    assert.equal(row.acknowledged_at, null);
    assert.ok(row.due_at && Date.parse(row.due_at) < Date.now(), "the chip prints the date that passed");
    assert.equal(rows[0].id, late.id, "overdue leads the To confirm group whatever the other deadlines");
    const dashboard = await listPendingAcksFor(readerId, scope);
    assert.equal(dashboard[0].id, late.id, "and the dashboard's first title");
    assert.equal(dashboard[0].overdue, true);
    assert.ok(dashboard.slice(1).every((d) => !d.overdue), "only that one");
    assert.equal(await countOverdueAcksFor(readerId, scope), 1, "the dashboard's '· 1 overdue'");
    assert.equal(await countOverdueAcksFor(readerId, asScope([emptySpaceId])), 0, "the scope holds");
    assert.equal(await countOverdueAcksFor(editorId, scope), 0, "the editor's row on the same policy keeps its own deadline");
    assert.equal(await countPendingAcksFor(readerId, scope), dashboard.length, "the badge counts it among the pending ones, not twice");

    // The grace from the cascade: the policy's own number, else the space's
    // policy_defaults (a junk value there reads as unset), else the built-in 0.
    assert.equal(
      (await fixtureQuery("UPDATE policy_settings SET overdue_grace_days = 3 WHERE document_id = $1", [late.id])).rowCount,
      1,
      "the policy's settings row (written at switch-on)"
    );
    assert.equal(await stateOf(), "pending", "3 days of grace: two days late is not yet overdue");
    assert.equal(await countOverdueAcksFor(readerId, scope), 0);
    assert.equal((await listPendingAcksFor(readerId, scope)).find((d) => d.id === late.id)!.overdue, false);
    await fixtureQuery("UPDATE policy_settings SET overdue_grace_days = 1 WHERE document_id = $1", [late.id]);
    assert.equal(await stateOf(), "overdue", "one day of grace has passed");
    await fixtureQuery("UPDATE policy_settings SET overdue_grace_days = NULL WHERE document_id = $1", [late.id]);
    await fixtureQuery(`UPDATE spaces SET policy_defaults = '{"overdue_grace_days": 5}' WHERE id = $1`, [spaceId]);
    assert.equal(await stateOf(), "pending", "the space's grace applies when the policy inherits");
    await fixtureQuery(`UPDATE spaces SET policy_defaults = '{"overdue_grace_days": "x"}' WHERE id = $1`, [spaceId]);
    assert.equal(await stateOf(), "overdue", "a junk space value reads as unset, as sanitizeLayer reads it");
    await fixtureQuery(`UPDATE spaces SET policy_defaults = '{"overdue_grace_days": 120}' WHERE id = $1`, [spaceId]);
    assert.equal(await stateOf(), "overdue", "an out-of-range space value reads as unset too");
    await fixtureQuery("UPDATE spaces SET policy_defaults = '{}' WHERE id = $1", [spaceId]);
    assert.equal(await stateOf(), "overdue");

    // A confirmation ends it, however old the deadline; a lapse with the
    // deadline still past is 'overdue', not 'reconfirm' (the deadline is
    // the fact to act on), and the earlier confirmation is still the prior one.
    await recordAcknowledgement(late.id, readerId, "", late.v1);
    assert.equal(await stateOf(), "confirmed");
    assert.equal(await countOverdueAcksFor(readerId, scope), 0);
    const v2 = await reset(late.id, "The cap is now 75.");
    await backdate();
    const lapsed = (await mine(scope)).find((r) => r.id === late.id)!;
    assert.equal(lapsed.state, "overdue");
    assert.ok(lapsed.prior_acknowledged_at, "the lapsed confirmation is still the prior one");
    assert.equal(await countOverdueAcksFor(readerId, scope), 1);
    await recordAcknowledgement(late.id, readerId, "", v2);
    assert.equal(await stateOf(), "confirmed");
    assert.equal(await countOverdueAcksFor(readerId, scope), 0);
  });

  test("getMyAssignment: the reader's own row with its deadline and cycle; null without an open row; the per-person ask that restarted the cycle (D4)", async () => {
    const p = await newPolicy(`${STAMP} mine`);
    const marker = async () =>
      String((await pool().query("SELECT ack_revision_at FROM documents WHERE id = $1", [p.id])).rows[0].ack_revision_at);
    const row = await getMyAssignment(p.id, readerId);
    assert.ok(row, "the reader has an open row");
    assert.ok(row.due_at && Date.parse(row.due_at) > Date.now(), "the deadline for the chips");
    assert.ok(row.cycle_started_at);
    assert.equal(row.asked_again, null, "enrolment is not a re-ask");
    assert.equal(await getMyAssignment(p.id, 0), null, "no row, no card");

    // A per-person re-ask (D4): the row's cycle restarts after the marker
    // (which stays), and the ledger row stamped at that same instant is the
    // reason the page shows this reader and nobody else.
    const before = await marker();
    await recordAcknowledgement(p.id, readerId, "", p.v1);
    const claim = await claimReconfirmation(null, p.id, {
      source: "manual",
      reason: "Please read section 4 again",
      actor: { id: editorId, name: "My Policies Editor" },
      userIds: [readerId],
    });
    assert.equal(claim.claimed, true);
    const again = await getMyAssignment(p.id, readerId);
    assert.ok(again?.asked_again, "the ask is on the row");
    assert.equal(again.asked_again.reason, "Please read section 4 again");
    assert.equal(again.asked_again.decided_by_name, "My Policies Editor");
    assert.equal(Date.parse(again.asked_again.decided_at), Date.parse(again.cycle_started_at), "one instant for the row and the ledger row");
    assert.ok(Date.parse(again.cycle_started_at) > Date.parse(before), "the cycle restarted after the marker");
    assert.equal(await marker(), before, "which did not move");
    assert.equal((await getMyAssignment(p.id, editorId))?.asked_again, null, "the editor was not asked");
    assert.equal((await mine()).find((r) => r.id === p.id)!.state, "reconfirm", "the reader's confirmation lapsed");
    assert.ok(again.due_at && Date.parse(again.due_at) > Date.now(), "the deadline was re-armed with the ask");

    // An exempt row is not an open row: no card, no cues.
    await fixtureQuery("UPDATE policy_assignments SET exempt_at = now() WHERE document_id = $1 AND user_id = $2", [p.id, readerId]);
    assert.equal(await getMyAssignment(p.id, readerId), null);
    await fixtureQuery("UPDATE policy_assignments SET exempt_at = NULL WHERE document_id = $1 AND user_id = $2", [p.id, readerId]);
    assert.ok(await getMyAssignment(p.id, readerId));
  });
});

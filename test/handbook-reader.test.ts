// The handbook reader's server side (1.18.0, H3): what the contents rail
// and the policy page say for one reader, worked out by
// components/handbooks/reader/reader-data from the same rows the document
// page reads. Licensed (policy_ack through the ee stub): a policy that asks
// the reader is "To confirm", then "Confirmed" with a tick and the progress
// counted, then "Updated since you confirmed" with "What changed in version
// 3" built from the version note after everyone is asked again; a policy
// that does not ask is "For information"; a reader who cannot browse the
// policy's space still gets its content through the handbook, but no
// "Compare versions" link (it would 404) and no related document outside
// the handbook. Unlicensed: no standing, no progress, no seed.
//
// The handbooks are real rows, read through lib/handbooks
// (getHandbookPolicy: the reader's access path, audience and all), and the
// facts row is derived, not stubbed: the owner is the policy's own owner
// (policy_settings), the approver is the reviewer who approved its change
// request, the effective date is that version's.
//
// Fixtures stay this file's own (integration files share one database and
// run in parallel): both spaces are private, the open one granted to this
// file's group, and every handbook's audience is this file's groups, so a
// policy switched on here asks nobody outside this file but the workspace's
// administrators.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/handbook-reader.test.ts

import { edition } from "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  approveChangeRequest,
  createChangeRequest,
  createDocument,
  createSpace,
  hasOpenAssignment,
  listVersions,
  recordAcknowledgement,
  setSpaceGroups,
  updateDocument,
  updatePolicySettings,
} from "../src/lib/db";
import { addRelation } from "../src/lib/relations";
import { setPolicyFacts } from "../src/lib/policy-facts";
import { scopeAllows, spaceScopeFor } from "../src/lib/access";
import { formatDate } from "../src/lib/format";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";
import type { DocumentWithSpace, SessionUser } from "../src/lib/types";

const STAMP = `HBR${Date.now().toString(36)}`;
const BODY = "## Purpose\n\nWhy this policy exists.\n\n## Entitlement\n\nTwenty-five days.";

let reader: SessionUser; // reads the open space, in the handbook's audience
let outsider: SessionUser; // in the handbooks' audiences, reads neither space
let stranger: SessionUser; // in nothing
let owner: SessionUser; // the PTO policy's own owner
let submitter: SessionUser; // proposed PTO's second version
let approver: SessionUser; // approved it
let openSpaceId = 0;
let closedSpaceId = 0;
let readersGroup = 0; // reader, owner: granted the open space
let audienceGroup = 0; // reader + outsider: the handbook's audience
let boardGroup = 0; // outsider: the board handbook's audience
let hbId = 0; // PTO, onboarding, board conduct
let boardHbId = 0; // board approvals only
const docIds: number[] = [];
const userIds: number[] = [];
const handbookIds: number[] = [];
let ptoId = 0; // asks everyone it reaches (open space + the handbook's audience)
let infoId = 0; // asks nobody
let secretId = 0; // closed space, asks nobody, handbook only: only the handbook opens it
let outsideId = 0; // related to PTO, not in the handbook
let boardId = 0; // closed space, asks the board handbook's reader

// Loaded after the stub is in place (imports run in order; this keeps the
// reader module's own imports behind it too).
let data: typeof import("../src/components/handbooks/reader/reader-data");
let handbooks: typeof import("../src/lib/handbooks");

async function makeUser(name: string): Promise<SessionUser> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP.toLowerCase()}_${name}`, `${STAMP} ${name}`, `${STAMP.toLowerCase()}_${name}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return { id: r.rows[0].id, username: `${STAMP.toLowerCase()}_${name}`, name: `${STAMP} ${name}`, role: "viewer" } as unknown as SessionUser;
}

async function makeGroup(name: string, members: SessionUser[]): Promise<number> {
  const g = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} ${name}`]);
  for (const m of members) await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [g.rows[0].id, m.id]);
  return g.rows[0].id;
}

async function makeDoc(spaceId: number, title: string, type: "policy" | "sop" = "policy"): Promise<DocumentWithSpace> {
  const d = await createDocument({
    space_id: spaceId,
    title: `${STAMP} ${title}`,
    type,
    status: "published",
    content: BODY,
    summary: "",
    tags: [],
    author: "Aisha Rahman",
    category_id: null,
  } as Parameters<typeof createDocument>[0]);
  docIds.push(d.id);
  return d;
}

/** A published workspace handbook (confirm the whole handbook on) for `groupId`, one section holding `docs` in order. */
async function makeHandbook(title: string, groupId: number, docs: number[]): Promise<number> {
  const h = await fixtureQuery(
    `INSERT INTO handbooks (title, status, audience, confirm_whole, created_by_name, published_at)
     VALUES ($1, 'published', 'groups', 1, 'test', now()) RETURNING id`,
    [`${STAMP} ${title}`]
  );
  const id = h.rows[0].id as number;
  handbookIds.push(id);
  await pool().query("INSERT INTO handbook_audience (handbook_id, group_id) VALUES ($1, $2)", [id, groupId]);
  const sec = await pool().query("INSERT INTO handbook_sections (handbook_id, title, position) VALUES ($1, 'Working here', 0) RETURNING id", [id]);
  for (const [i, docId] of docs.entries()) {
    await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, $4)", [
      id,
      sec.rows[0].id,
      docId,
      i,
    ]);
  }
  return id;
}

/** The reader's view of one policy, through the handbook's own access path. */
async function view(user: SessionUser, docId: number, handbookId = hbId) {
  const policy = await handbooks.getHandbookPolicy(user, handbookId, docId);
  assert.ok(policy, `handbook ${handbookId} opens document ${docId} to ${user.name}`);
  const base = await data.loadReaderBase(user, policy.handbook, SETTINGS_DEFAULTS);
  const v = await data.loadPolicyView(user, base, policy, SETTINGS_DEFAULTS);
  return { base, v };
}

before(async () => {
  data = await import("../src/components/handbooks/reader/reader-data");
  handbooks = await import("../src/lib/handbooks");
  const open = await createSpace({ slug: `${STAMP.toLowerCase()}-open`, name: `${STAMP} People Ops`, visibility: "private" });
  const closed = await createSpace({ slug: `${STAMP.toLowerCase()}-closed`, name: `${STAMP} Board`, visibility: "private" });
  openSpaceId = open.id;
  closedSpaceId = closed.id;
  reader = await makeUser("reader");
  outsider = await makeUser("outsider");
  stranger = await makeUser("stranger");
  owner = await makeUser("owner");
  submitter = await makeUser("submitter");
  approver = await makeUser("approver");
  // The owner reads the space (the Settings tab only takes an owner who can).
  readersGroup = await makeGroup("People Ops readers", [reader, owner]);
  audienceGroup = await makeGroup("Handbook readers", [reader, outsider]);
  boardGroup = await makeGroup("Board readers", [outsider]);
  await setSpaceGroups(openSpaceId, [readersGroup]);

  ptoId = (await makeDoc(openSpaceId, "Paid Time Off Policy")).id;
  infoId = (await makeDoc(openSpaceId, "Onboarding Checklist", "sop")).id;
  secretId = (await makeDoc(closedSpaceId, "Board Conduct Policy")).id;
  outsideId = (await makeDoc(closedSpaceId, "Sickness Policy")).id;
  boardId = (await makeDoc(closedSpaceId, "Board Approvals Policy")).id;
  await pool().query("UPDATE documents SET find_mode = 'handbook_only' WHERE id = $1", [secretId]);

  // PTO's facts, the real way: version 2 is a reviewed change request, the
  // policy has its own owner, and its "In short" / "Applies to" are set.
  const cr = await createChangeRequest({
    document_id: ptoId,
    kind: "edit",
    title: `${STAMP} Paid Time Off Policy`,
    content: `${BODY}\n\nAsk your manager two weeks ahead.`,
    summary: "",
    tags: [],
    type: "policy",
    target_status: "published",
    note: "Notice period added",
    created_by: submitter.id,
  });
  assert.ok(await approveChangeRequest(cr, approver.id, approver.name), "the change request is approved");
  await updatePolicySettings(ptoId, { owner_user_id: owner.id });
  await setPolicyFacts(ptoId, { summary_points: ["You get **25 days** a year."], applies_to: "All employees" });

  hbId = await makeHandbook("Handbook", audienceGroup, [ptoId, infoId, secretId]);
  boardHbId = await makeHandbook("Board Handbook", boardGroup, [boardId]);
  // Switched on after the handbooks are published: the first audience is
  // the open space's readers and the people the handbooks let read them.
  await switchOn(ptoId);
  await switchOn(boardId);
  await addRelation(ptoId, infoId, "related", reader.id);
  await addRelation(ptoId, outsideId, "related", reader.id);
});

after(async () => {
  edition.features = ["policy_ack"];
  await fixtureQuery("DELETE FROM handbooks WHERE id = ANY($1)", [handbookIds]);
  await fixtureQuery("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1)", [docIds.map(String)]);
  await fixtureQuery("DELETE FROM doc_relations WHERE doc_id = ANY($1) OR target_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM attested_texts WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await fixtureQuery("DELETE FROM change_requests WHERE document_id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM groups WHERE id = ANY($1)", [[readersGroup, audienceGroup, boardGroup]]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = ANY($1)", [[openSpaceId, closedSpaceId]]);
  await pool().end();
});

const facts = (v: { facts: { label: string; value: string }[] }) => Object.fromEntries(v.facts.map((f) => [f.label, f.value]));

describe("the handbook reader (licensed)", () => {
  test("a policy that asks the reader: To confirm, then Confirmed with a tick, then Updated with what changed", async () => {
    assert.equal(await hasOpenAssignment(ptoId, reader.id), true, "the space's reader is asked");
    assert.equal(await hasOpenAssignment(ptoId, stranger.id), false, "nobody outside the space and the handbook is");
    let { base, v } = await view(reader, ptoId);
    assert.equal(v.standing, "to_confirm");
    assert.deepEqual(base.progress, { confirmed: 0, total: 1 }, "only the policy that asks counts");
    assert.equal(base.contents[0].items[0].confirmed, false);
    assert.ok(v.ackSeed, "the bar is seeded");
    let [latest] = await listVersions(ptoId);
    assert.equal(v.ackSeed!.versionId, latest.id, "the bar confirms the version on screen");
    assert.equal(v.ackSeed!.rev, 2, "version 2: the approved change request");
    assert.equal(v.confirm.forInformation, false);
    assert.equal(v.whatChanged, null);
    assert.equal(v.number, 1);
    assert.equal(v.total, 3);
    assert.equal(v.next?.href, `/handbooks/${hbId}/${infoId}`);
    assert.equal(v.finish, null, "not the last policy");
    // The facts row, derived: the policy's own owner, the reviewer who
    // approved the version on screen, its number and its date.
    let f = facts(v);
    assert.equal(f.Owner, owner.name, "the policy's own owner (policy_settings)");
    assert.equal(f["Approved by"], approver.name, "the change request's reviewer");
    assert.equal(f.Version, "2");
    assert.equal(f.Effective, formatDate(latest.created_at, SETTINGS_DEFAULTS), "version 2's date, as the printed copy formats it");
    assert.equal(f["Applies to"], "All employees");
    assert.equal(f["Next review"], "");
    assert.deepEqual(v.summaryPoints, ["You get **25 days** a year."]);
    // Two policies and an SOP (the checklist): the count names both kinds (1.18.2).
    assert.ok(base.subtitle.startsWith("2 policies and 1 SOP in 1 section · updated "), base.subtitle);
    assert.equal(v.position, "Document 1 of 3", "a mixed handbook numbers documents");
    assert.equal(v.noun, "policy", "the policy still speaks of itself as a policy");
    assert.ok(base.subtitle.endsWith("for the whole workspace"));
    // Related: inside the handbook it opens here; outside it, only when the reader may open it (not here).
    assert.deepEqual(v.related.map((r) => r.href), [`/handbooks/${hbId}/${infoId}`]);

    const r = await recordAcknowledgement(ptoId, reader.id, "", latest.id, {});
    assert.equal(r.recorded, true);
    ({ base, v } = await view(reader, ptoId));
    assert.equal(v.standing, "confirmed");
    assert.equal(base.contents[0].items[0].confirmed, true, "the rail ticks it");
    assert.deepEqual(base.progress, { confirmed: 1, total: 1 });
    assert.ok(v.ackSeed!.ackedAt, "the bar opens on its done state");

    // Everyone is asked again after a text change with a note.
    const confirmedVersion = latest;
    await updateDocument(ptoId, {
      content: `${BODY}\n\nUp to five days carry over.`,
      status: "published",
      versionNote: "Carry-over rose from 3 to 5 days",
      ackPolicy: "reset",
      ackReason: "Carry-over rose from 3 to 5 days",
    });
    ({ base, v } = await view(reader, ptoId));
    assert.equal(v.standing, "updated");
    assert.equal(base.contents[0].items[0].confirmed, false, "the tick leaves with the lapse");
    assert.ok(v.whatChanged, "the box shows");
    assert.equal(v.whatChanged!.rev, 3);
    assert.equal(v.whatChanged!.confirmedRev, 2);
    assert.deepEqual(v.whatChanged!.notes, ["Carry-over rose from 3 to 5 days"]);
    assert.equal(v.whatChanged!.compareHref, `/doc/${ptoId}/history?from=${confirmedVersion.id}&to=current`, "the reader may open the space");
    assert.equal(v.ackSeed!.ackedAt, null, "the bar asks again");
    assert.equal(v.ackSeed!.rev, 3);
    // The facts follow the version on screen: version 3 went live without a review.
    [latest] = await listVersions(ptoId);
    f = facts(v);
    assert.equal(f.Version, "3");
    assert.equal(f["Approved by"], "", "no review, no approver");
    assert.equal(f.Effective, formatDate(latest.created_at, SETTINGS_DEFAULTS));
    assert.equal(f.Owner, owner.name, "the owner is the policy's, whatever the version");
  });

  test("a policy that asks nobody is For information; the last one offers Confirm handbook", async () => {
    const { v } = await view(reader, infoId);
    assert.equal(v.standing, null);
    assert.equal(v.ackSeed, null);
    assert.equal(v.confirm.forInformation, true);
    // No owner anywhere: the owner is the version's publisher (createDocument: the byline).
    assert.equal(facts(v).Owner, "Aisha Rahman");
    assert.equal(facts(v)["Approved by"], "");
    const last = await view(reader, secretId);
    assert.equal(last.v.next, null);
    assert.deepEqual(last.v.finish, { href: `/handbooks/${hbId}/confirm`, label: "Confirm handbook" });
    assert.equal(last.v.handbookOnly, true);
  });

  test("a reader who cannot browse the space reads through the handbook, without links that would 404", async () => {
    // The real access checks: the closed space is outside the outsider's
    // scope (so /doc/{id} is a 404 for them), yet the handbook opens it.
    assert.equal(scopeAllows(await spaceScopeFor(outsider), closedSpaceId), false);
    const { v } = await view(outsider, secretId);
    assert.ok(v.content.includes("Twenty-five days"), "the content comes through the handbook");
    assert.equal(v.standing, null);
    // Only the handbook's audience, only what the handbook holds.
    assert.equal(await handbooks.getHandbookPolicy(stranger, hbId, secretId), undefined, "not in the audience");
    assert.equal(await handbooks.getHandbookPolicy(outsider, hbId, outsideId), undefined, "a closed-space document the handbook does not hold");
    assert.equal(await handbooks.getHandbookPolicy(outsider, boardHbId, secretId), undefined, "a handbook that does not hold it");
    // PTO's related documents: the one in the handbook opens here, the closed one is not offered.
    const pto = await view(outsider, ptoId);
    assert.deepEqual(pto.v.related.map((r) => r.href), [`/handbooks/${hbId}/${infoId}`]);
  });

  test("an outsider who confirmed version 1 of a closed-space policy is asked again: what changed, but no compare link", async () => {
    assert.equal(await hasOpenAssignment(boardId, outsider.id), true, "the handbook's reader is in the policy's audience");
    assert.equal(await hasOpenAssignment(boardId, reader.id), false, "the board handbook is not the reader's");
    let { v } = await view(outsider, boardId, boardHbId);
    assert.equal(v.standing, "to_confirm");
    const [v1] = await listVersions(boardId);
    assert.equal((await recordAcknowledgement(boardId, outsider.id, "", v1.id, {})).recorded, true);
    ({ v } = await view(outsider, boardId, boardHbId));
    assert.equal(v.standing, "confirmed");
    await updateDocument(boardId, {
      content: `${BODY}\n\nSpending over 10,000 needs two approvals.`,
      status: "published",
      versionNote: "Two approvals over 10,000",
      ackPolicy: "reset",
      ackReason: "Two approvals over 10,000",
    });
    ({ v } = await view(outsider, boardId, boardHbId));
    assert.equal(v.standing, "updated");
    assert.ok(v.whatChanged, "the box shows what changed");
    assert.equal(v.whatChanged!.rev, 2);
    assert.equal(v.whatChanged!.confirmedRev, 1);
    assert.deepEqual(v.whatChanged!.notes, ["Two approvals over 10,000"]);
    assert.equal(v.whatChanged!.compareHref, null, "no Compare versions link: /doc/{id}/history would 404 for them");
    assert.equal(v.ackSeed!.rev, 2, "the bar asks for version 2");
  });
});

describe("the handbook reader (unlicensed)", () => {
  test("no standing, no progress, no bar seed", async () => {
    edition.features = [];
    try {
      const { base, v } = await view(reader, ptoId);
      assert.equal(base.ackLicensed, false);
      assert.equal(base.progress, null);
      assert.equal(base.confirmWhole, false);
      assert.equal(v.standing, null);
      assert.equal(v.ackSeed, null);
      assert.equal(v.confirm.forInformation, false, "nothing about confirming at all");
      assert.equal(v.finish, null);
    } finally {
      edition.features = ["policy_ack"];
    }
  });
});

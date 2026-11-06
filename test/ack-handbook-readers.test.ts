// People asked to confirm a policy only through a handbook (1.18.3). Since
// 1.18.0 a person in the audience of a PUBLISHED handbook that holds a
// policy is in the policy's audience (ACK_DOC_VISIBILITY) even when they
// cannot open its space; from 1.18.3 they are also reached: My policies,
// the dashboard row, the sidebar count and the nav gate list the policy
// with `via_handbook` (blank space fields), every notice links them into
// the handbook reader with a line naming it, Remind / the stamp / the
// pending list include them, and the team view, Team compliance, the
// portal's queue, the roster and the person record count them and carry
// `via_handbook_title`. A space reader of the same policy keeps the space
// path (via_handbook null, /doc links). Unpublishing the handbook takes it
// all away again. The handbook's title reaches only a viewer who may see
// that handbook (in its audience, or managing it) and the person
// themself; anyone else (the outsider: a lead and roster reader outside
// its audience) reads `asked_through_handbook` with a null title and "a
// handbook" in the CSV's asked_through cell.
//
// Fixtures are this file's own: a private space granted to its own group
// (the space reader), a second group that only the handbooks' audience
// names (the handbook reader). No admin accounts, so another file's
// private-space switch-on never enrols one of ours, and every assertion
// about lists that the shared database can grow (another file's
// internal-space policy enrols every active account) is "includes", never
// "equals". lib/ee is stubbed as handbook-confirm.test.ts does it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/ack-handbook-readers.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

import {
  pool,
  getSetting,
  createDocument,
  setSpaceGroups,
  getUserById,
  listMyPolicies,
  listPendingAcksFor,
  countPendingAcksFor,
  countOverdueAcksFor,
  hasPolicyInScope,
  compliancePendingUsers,
  stampAckReminded,
  ackHandbookRoutes,
  ackRouteKey,
  insertAckOutbox,
  teamPolicyRows,
  reportPolicyStanding,
  leadMayRemind,
  ackStatusForDocument,
  policyNeedsAttention,
  complianceDocs,
  userPolicyTranscript,
  listOwedPoliciesFor,
  createRole,
  assignRole,
} from "../src/lib/db";
import type { SessionUser } from "../src/lib/types";
import { spaceScopeFor } from "../src/lib/access";
import { deliverAckNotices, notifyWelcome, type Mailer } from "../src/lib/compliance";
import { renderEmail, HANDBOOK_LINE } from "../src/lib/email-templates";
import { ackConfirmHref, bundleList } from "../src/lib/ack-remind";
import { RECORD_CSV_HEADER, recordCsvCells, askedThroughCell, ASKED_THROUGH_UNNAMED } from "../src/lib/read-evidence";
import { fixtureQuery } from "./support/retry";
import { switchOn, assignEveryone } from "./support/assign";

// --- lib/ee as a licensed build sees it (for the modules loaded lazily) ----------
const EE_STUB = path.join(__dirname, "stubs", "ee.ack-handbook-readers.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => ({ present: true, features: ["policy_ack"] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => feature === "policy_ack",
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "./ee" && parent?.filename && path.resolve(path.dirname(parent.filename), "ee") === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

const STAMP = `hbreaders-${Date.now()}`;
const ORIGIN = "https://docs.example.test";

let spaceId = 0;
let spaceName = "";
let staffGroup = 0; // the space's group: spaceReader
let readersGroup = 0; // the handbooks' audience: reader (and spaceReader too)
let readerId = 0; // handbook-only
let spaceReaderId = 0; // opens the space, and is also in the handbook audience
let outsiderId = 0; // opens the space, leads the readers' group, reads the roster; outside every handbook audience
let reader: SessionUser;
let spaceReader: SessionUser;
let outsider: SessionUser;
const roleIds: number[] = [];
const docIds: number[] = [];
const handbookIds: number[] = [];
let mainHb = 0; // the lowest-id published handbook admitting the reader
let mainHbTitle = "";
let policy = { id: 0, title: "" };

async function newDoc(title: string): Promise<{ id: number; title: string }> {
  const doc = await createDocument({
    space_id: spaceId,
    title: `${STAMP} ${title}`,
    type: "policy",
    status: "published",
    content: `${title}: staff must follow the procedure described here.`,
    summary: "",
    tags: [],
    author: "test",
  });
  docIds.push(doc.id);
  await switchOn(doc.id, { editDefault: null, recertMonths: null });
  return { id: doc.id, title: doc.title };
}

async function newHandbook(title: string, docs: number[], groups: number[], status: "draft" | "published" = "published"): Promise<number> {
  const hb = await fixtureQuery(
    `INSERT INTO handbooks (title, status, audience, confirm_whole, require_signature, created_by_name, published_at)
     VALUES ($1, $2, 'groups', 0, 0, 'test', now()) RETURNING id`,
    [`${STAMP} ${title}`, status]
  );
  const id = hb.rows[0].id as number;
  handbookIds.push(id);
  for (const g of groups) await pool().query("INSERT INTO handbook_audience (handbook_id, group_id) VALUES ($1, $2)", [id, g]);
  const sec = await pool().query("INSERT INTO handbook_sections (handbook_id, title, position) VALUES ($1, 'Policies', 0) RETURNING id", [id]);
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

const sessionUser = async (id: number) => (await getUserById(id)) as unknown as SessionUser;
const scopeOf = (u: SessionUser) => spaceScopeFor(u);

/** A recording mailer: every mail by recipient. */
function recorder() {
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  const mailer: Mailer = async (to, subject, text, html) => {
    for (const t of to) sent.push({ to: t, subject, text, html: html ?? "" });
  };
  return { sent, mailer };
}
const emailOf = (id: number) => (id === readerId ? `${STAMP}-reader@example.test` : `${STAMP}-space@example.test`);

/** The user's notifications of a kind for one of this file's policies (another file's policies may notify the same account). */
async function inbox(userId: number, kind: string, docId = policy.id): Promise<{ title: string; body: string; link: string }[]> {
  const r = await pool().query(
    "SELECT title, body, link FROM notifications WHERE user_id = $1 AND kind = $2 AND link LIKE '%/' || $3::text || '#%' ORDER BY id",
    [userId, kind, docId]
  );
  return r.rows;
}

/** Nothing queued for this file's policies but what the test queues itself. */
async function clearOutbox(): Promise<void> {
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [[readerId, spaceReaderId]]);
}

const drain = (mailer: Mailer) => deliverAckNotices({ origin: ORIGIN, mailer, limit: 50, documentIds: docIds, heartbeatEvery: 1 });

before(async () => {
  await getSetting("__schema_bootstrap__");
  spaceName = `Handbook Readers ${STAMP}`;
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '🔐', '', 'private') RETURNING id`,
    [spaceName, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status, password_hash, password_salt) VALUES
       ($1, 'Hbr Reader', $2, 'viewer', 'active', 'x', 'x'),
       ($3, 'Hbr Space', $4, 'viewer', 'active', 'x', 'x'),
       ($5, 'Hbr Outsider', $6, 'viewer', 'active', 'x', 'x')
     RETURNING id`,
    [
      `${STAMP}-reader`,
      `${STAMP}-reader@example.test`,
      `${STAMP}-space`,
      `${STAMP}-space@example.test`,
      `${STAMP}-outsider`,
      `${STAMP}-outsider@example.test`,
    ]
  );
  readerId = users.rows[0].id;
  spaceReaderId = users.rows[1].id;
  outsiderId = users.rows[2].id;
  const g1 = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Space staff`]);
  staffGroup = g1.rows[0].id;
  const g2 = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Handbook readers`]);
  readersGroup = g2.rows[0].id;
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)", [staffGroup, spaceReaderId, outsiderId]);
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)", [readersGroup, readerId, spaceReaderId]);
  // The space reader leads the readers' group (the team view, a lead's Remind).
  // The outsider leads it too without being in it (no handbook's audience
  // names them). Both hold the approver preset on the space
  // (document.ack_roster_read), so each opens the reader's record.
  await pool().query("INSERT INTO group_leads (group_id, user_id) VALUES ($1, $2), ($1, $3)", [readersGroup, spaceReaderId, outsiderId]);
  await setSpaceGroups(spaceId, [staffGroup]);
  await fixtureQuery(
    `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id)
     SELECT r.id, u, 'space', $3 FROM roles r, unnest(ARRAY[$1::int, $2::int]) u WHERE r.key = 'approver'`,
    [spaceReaderId, outsiderId, spaceId]
  );

  policy = await newDoc("Code of Conduct");
  for (const t of ["Expenses", "Travel", "Remote work"]) await newDoc(t);

  // Handbooks in id order: a draft one the reader is in the audience of, a
  // published one whose audience is the space's group only (not the
  // reader's), the one the reader is sent to, and a later one that holds
  // the policy too. The reader's route is the third: the lowest id among
  // the PUBLISHED handbooks whose audience admits them.
  await newHandbook("Draft handbook", [policy.id], [readersGroup], "draft");
  await newHandbook("Staff handbook", [policy.id], [staffGroup]);
  mainHb = await newHandbook("Employee Handbook", docIds, [readersGroup]);
  mainHbTitle = `${STAMP} Employee Handbook`;
  await newHandbook("Later handbook", [policy.id], [readersGroup]);
  for (const id of docIds) await assignEveryone(id);
  reader = await sessionUser(readerId);
  spaceReader = await sessionUser(spaceReaderId);
  outsider = await sessionUser(outsiderId);
  await clearOutbox();
});

after(async () => {
  const userIds = [readerId, spaceReaderId, outsiderId];
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  if (roleIds.length) await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM handbooks WHERE id = ANY($1)", [handbookIds]);
  await pool().query("DELETE FROM ack_notices WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1)", [docIds.map(String)]);
  await pool().query("DELETE FROM policy_assignments WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1) OR space_id = $2", [docIds, spaceId]);
  await pool().query("DELETE FROM group_leads WHERE group_id = ANY($1)", [[staffGroup, readersGroup]]);
  await pool().query("DELETE FROM group_members WHERE group_id = ANY($1)", [[staffGroup, readersGroup]]);
  await pool().query("DELETE FROM groups WHERE id = ANY($1)", [[staffGroup, readersGroup]]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("handbook-only readers (1.18.3)", () => {
  test("the fixture: the reader cannot open the space, both are asked", async () => {
    const scope = await scopeOf(reader);
    assert.ok(scope !== "all" && !scope.includes(spaceId), "the reader's scope leaves the private space out");
    const pending = (await compliancePendingUsers(policy.id)).map((u) => u.id);
    assert.ok(pending.includes(readerId), "the handbook reader is pending (ACK_DOC_VISIBILITY)");
    assert.ok(pending.includes(spaceReaderId));
  });

  test("My policies, the dashboard row, the counts and the nav gate include the reader's policy, via the first published handbook that admits them", async () => {
    const scope = await scopeOf(reader);
    const mine = (await listMyPolicies(readerId, scope)).find((r) => r.id === policy.id);
    assert.ok(mine, "on My policies");
    assert.deepEqual(mine!.via_handbook, { id: mainHb, title: mainHbTitle }, "the lowest-id published handbook in their audience");
    assert.equal(mine!.space_name, "", "the space's name never reaches them");
    assert.equal(mine!.space_icon, "");
    assert.equal(mine!.state, "pending");

    const before = await listPendingAcksFor(readerId, scope);
    const count = await countPendingAcksFor(readerId, scope);
    const after = await listPendingAcksFor(readerId, scope);
    const row = before.find((r) => r.id === policy.id);
    assert.ok(row, "on the dashboard");
    assert.deepEqual(row!.via_handbook, { id: mainHb, title: mainHbTitle });
    assert.equal(row!.space_name, "");
    for (const id of docIds) assert.ok(before.some((r) => r.id === id), "every policy of the handbook");
    // The badge equals the list (bracketed: another file may enrol everyone between the reads).
    assert.ok(count >= Math.min(before.length, after.length) && count <= Math.max(before.length, after.length), `${count} vs ${before.length}/${after.length}`);

    await pool().query("UPDATE policy_assignments SET due_at = now() - interval '3 days' WHERE document_id = $1 AND user_id = $2", [
      policy.id,
      readerId,
    ]);
    const overdue = await countOverdueAcksFor(readerId, scope);
    const overdueRows = (await listPendingAcksFor(readerId, scope)).filter((r) => r.overdue);
    assert.ok(overdueRows.some((r) => r.id === policy.id), "the overdue row");
    assert.ok(overdue >= 1);
    assert.equal((await listMyPolicies(readerId, scope)).find((r) => r.id === policy.id)!.state, "overdue");
    assert.equal(await hasPolicyInScope(readerId, scope), true, "the nav gate opens");
  });

  test("a space reader of the same policy keeps the space path: via_handbook null, the space named", async () => {
    const scope = await scopeOf(spaceReader);
    const mine = (await listMyPolicies(spaceReaderId, scope)).find((r) => r.id === policy.id);
    assert.ok(mine);
    assert.equal(mine!.via_handbook, null, "the space path wins, though they are in the handbook's audience too");
    assert.equal(mine!.space_name, spaceName);
    const row = (await listPendingAcksFor(spaceReaderId, scope)).find((r) => r.id === policy.id);
    assert.equal(row!.via_handbook, null);
    assert.equal(row!.space_name, spaceName);
  });

  test("the notice routes: the handbook for the reader, the document for the space reader; never a draft or a handbook outside their audience", async () => {
    const routes = await ackHandbookRoutes([
      { document_id: policy.id, user_id: readerId },
      { document_id: policy.id, user_id: spaceReaderId },
    ]);
    assert.deepEqual(routes.get(ackRouteKey(policy.id, readerId)), { id: mainHb, title: mainHbTitle });
    assert.equal(routes.has(ackRouteKey(policy.id, spaceReaderId)), false);
    assert.equal(ackConfirmHref(policy.id, { id: mainHb }), `/handbooks/${mainHb}/${policy.id}#confirm-reading`);
    assert.equal(ackConfirmHref(policy.id, null), `/doc/${policy.id}#confirm-reading`);
  });

  test("Remind's stamp and the request fan-out reach the reader, linked into the handbook with a line naming it", async () => {
    await clearOutbox();
    assert.equal(await stampAckReminded(policy.id, [readerId, spaceReaderId]), 2, "both rows stamped");
    await insertAckOutbox(null, {
      document_id: policy.id,
      mode: "request",
      source: "manual",
      actor: { id: null, name: "Compliance" },
      user_ids: [readerId, spaceReaderId],
      origin: ORIGIN,
    });
    const { sent, mailer } = recorder();
    const r = await drain(mailer);
    assert.ok(r.delivered >= 1, JSON.stringify(r));

    const readerBell = await inbox(readerId, "ack_requested");
    assert.equal(readerBell.length, 1);
    assert.equal(readerBell[0].link, `/handbooks/${mainHb}/${policy.id}#confirm-reading`);
    assert.ok(readerBell[0].body.endsWith(`It's in ${mainHbTitle}.`), readerBell[0].body);
    const spaceBell = await inbox(spaceReaderId, "ack_requested");
    assert.equal(spaceBell.length, 1);
    assert.equal(spaceBell[0].link, `/doc/${policy.id}#confirm-reading`);
    assert.ok(!spaceBell[0].body.includes("It's in"), spaceBell[0].body);

    const readerMail = sent.find((m) => m.to === emailOf(readerId));
    const spaceMail = sent.find((m) => m.to === emailOf(spaceReaderId));
    assert.ok(readerMail && spaceMail, "one mail each");
    assert.ok(readerMail!.text.includes(`${ORIGIN}/handbooks/${mainHb}/${policy.id}#confirm-reading`), readerMail!.text);
    assert.ok(readerMail!.text.includes(`It's in ${mainHbTitle}.`), readerMail!.text);
    assert.ok(readerMail!.html.includes(`<strong>${mainHbTitle}</strong>`), "the handbook line keeps its bold");
    assert.ok(spaceMail!.text.includes(`${ORIGIN}/doc/${policy.id}#confirm-reading`));
    assert.ok(!spaceMail!.text.includes("It's in") && !spaceMail!.html.includes("It's in"), "no handbook line for a space reader");
  });

  test("the sweep's due reminder and the bundle link the reader into the handbook", async () => {
    await clearOutbox();
    // One 'due' row for the policy naming both (as the sweep and the bulk Remind queue it).
    await insertAckOutbox(null, {
      document_id: policy.id,
      mode: "due",
      source: "",
      user_ids: [readerId, spaceReaderId],
      payload: { rows: [{ user_id: readerId, due_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), overdue: true }, { user_id: spaceReaderId, due_at: null, overdue: false }] },
      delay_minutes: 0,
      origin: "",
    });
    const first = recorder();
    await drain(first.mailer);
    const due = await inbox(readerId, "ack_due");
    assert.equal(due.length, 1);
    assert.equal(due[0].link, `/handbooks/${mainHb}/${policy.id}#confirm-reading`);
    assert.ok(due[0].body.includes(`It's in ${mainHbTitle}.`));
    assert.equal((await inbox(spaceReaderId, "ack_due"))[0].link, `/doc/${policy.id}#confirm-reading`);
    const mail = first.sent.find((m) => m.to === emailOf(readerId))!;
    assert.ok(mail.text.includes(`/handbooks/${mainHb}/${policy.id}#confirm-reading`) && mail.text.includes(`It's in ${mainHbTitle}.`), mail.text);
    assert.ok(!first.sent.find((m) => m.to === emailOf(spaceReaderId))!.text.includes("It's in"));

    // Four due rows for the reader in one batch: one bundled notice whose list names the handbook.
    await clearOutbox();
    for (const id of docIds) {
      await insertAckOutbox(null, {
        document_id: id,
        mode: "due",
        source: "",
        user_ids: [readerId],
        payload: { rows: [{ user_id: readerId, due_at: null, overdue: false }] },
        delay_minutes: 0,
        origin: "",
      });
    }
    const second = recorder();
    await drain(second.mailer);
    const bundle = second.sent.filter((m) => m.to === emailOf(readerId));
    assert.equal(bundle.length, 1, "one bundled mail");
    assert.ok(bundle[0].text.includes(`${policy.title} (in ${mainHbTitle})`), bundle[0].text);
    assert.equal(bundleList([{ title: "A", due_at: null, overdue: true, handbook: "H" }]), "- A (in H, overdue)");
    assert.equal(bundleList([{ title: "A", due_at: null, overdue: false }]), "- A", "unchanged without a handbook");
  });

  test("the welcome's list names the handbook", async () => {
    await clearOutbox();
    const owed = (await listOwedPoliciesFor(readerId)).find((p) => p.id === policy.id);
    assert.equal(owed?.via_handbook_title, mainHbTitle);
    assert.equal((await listOwedPoliciesFor(spaceReaderId)).find((p) => p.id === policy.id)?.via_handbook_title, null);
    await notifyWelcome(readerId, [{ id: policy.id }, { id: docIds[1] }], ORIGIN);
    const { sent, mailer } = recorder();
    await drain(mailer);
    const mail = sent.find((m) => m.to === emailOf(readerId));
    assert.ok(mail, "the welcome went out");
    assert.ok(mail!.text.includes(`${policy.title} (in ${mainHbTitle}, due `), mail!.text);
  });

  test("the handbook_line tag renders only where it is given, and a template without it is unaffected", async () => {
    const base = {
      requester_name: "Dana",
      doc_title: "Code of Conduct",
      doc_url: "/doc/1#confirm-reading",
      request_type: "requested",
      request_label: "Action required",
      change_note: "",
      reason: "",
      due_date: "",
      due_line: "",
      due_suffix: "",
      days_left: "",
    };
    const plain = await renderEmail("ack_request", { ...base, handbook_title: "", handbook_line: "" }, ORIGIN);
    assert.ok(!plain.text.includes("It's in"));
    assert.doesNotMatch(plain.text + plain.html, /\{\{/);
    // A title that looks like markdown stays text inside the bold sentence.
    const named = await renderEmail("ack_request", { ...base, handbook_title: "[x](https://evil.example)", handbook_line: HANDBOOK_LINE }, ORIGIN);
    assert.ok(named.text.includes("It's in [x](https://evil.example)."), named.text);
    assert.ok(!named.html.includes('href="https://evil.example"'), "the title is never a link");
    // An older caller (or override) that sends no handbook tags at all.
    const legacy = await renderEmail("ack_due", { doc_title: "X", doc_url: "/doc/1", due_date: "", due_line: "", status_label: "Reminder" }, ORIGIN);
    assert.doesNotMatch(legacy.subject + legacy.text + legacy.html, /\{\{/, "an absent handbook tag renders blank, never raw");
  });

  test("the team view, Team compliance, a lead's Remind, the roster, the queue and the portal count the reader and carry via_handbook_title", async () => {
    const rows = await teamPolicyRows([readersGroup], spaceReaderId);
    const r = rows.find((x) => x.user_id === readerId && x.document_id === policy.id);
    assert.ok(r, "the reader's row in the team view");
    assert.equal(r!.via_handbook_title, mainHbTitle, "the lead is in the handbook's audience: named");
    assert.equal(r!.asked_through_handbook, true);
    const spaceRow = rows.find((x) => x.user_id === spaceReaderId && x.document_id === policy.id)!;
    assert.equal(spaceRow.via_handbook_title, null);
    assert.equal(spaceRow.asked_through_handbook, false);
    // A viewer who cannot read the space sees the reader's policies as a count only.
    const hidden = (await teamPolicyRows([readersGroup], readerId)).filter((x) => x.user_id === readerId);
    assert.ok(hidden.every((x) => x.document_id === null || !docIds.includes(x.document_id)));
    assert.ok(hidden[0].hidden_count >= docIds.length);

    const standing = (await reportPolicyStanding([readerId, spaceReaderId], spaceReaderId, 50)).find((p) => p.document_id === policy.id);
    assert.equal(standing?.owed, 2, "Team compliance counts both");

    const assignment = (
      await pool().query("SELECT id FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [policy.id, readerId])
    ).rows[0].id;
    const lead = await leadMayRemind(assignment, spaceReaderId, 7);
    assert.ok(lead && lead.leads, "the lead may remind the handbook reader");

    const roster = await ackStatusForDocument(policy.id, spaceReaderId);
    const rosterRow = roster.find((x) => x.id === readerId)!;
    assert.equal(rosterRow.via_handbook_title, mainHbTitle);
    assert.equal(rosterRow.asked_through_handbook, true);
    assert.equal(askedThroughCell(rosterRow), mainHbTitle, "the roster and matrix CSVs' asked_through cell");
    const spaceRosterRow = roster.find((x) => x.id === spaceReaderId)!;
    assert.equal(spaceRosterRow.via_handbook_title, null);
    assert.equal(spaceRosterRow.asked_through_handbook, false);
    assert.equal(askedThroughCell(spaceRosterRow), "");
    const anonymous = (await ackStatusForDocument(policy.id)).find((x) => x.id === readerId)!;
    assert.equal(anonymous.via_handbook_title, null, "no viewer, no title");
    assert.equal(anonymous.asked_through_handbook, true);

    const queue = await policyNeedsAttention(200, { documentIds: [policy.id], viewerId: spaceReaderId });
    const q = queue.rows.find((x) => x.user_id === readerId && x.reason === "overdue");
    assert.ok(q, "the overdue reader is in the portal's queue");
    assert.equal(q!.via_handbook_title, mainHbTitle);
    assert.equal(q!.asked_through_handbook, true);
    const spaceQ = queue.rows.find((x) => x.user_id === spaceReaderId);
    if (spaceQ) assert.equal(spaceQ.asked_through_handbook, false);

    const doc = (await complianceDocs()).find((d) => d.id === policy.id)!;
    assert.ok(doc.required >= 2 && doc.overdue >= 1, "the portal's counts include the reader");
  });

  test("the reader's own record: via_handbook on the row, no space name, the CSV's asked_through", async () => {
    const own = await userPolicyTranscript(readerId, reader);
    const row = own!.current.find((x) => x.document_id === policy.id)!;
    assert.deepEqual(row.via_handbook, { id: mainHb, title: mainHbTitle });
    assert.equal(row.via_handbook_title, mainHbTitle);
    assert.equal(row.space_name, "", "their own record does not name a space they cannot open");
    const cells = recordCsvCells(row);
    assert.equal(cells.length, RECORD_CSV_HEADER.split(",").length);
    assert.equal(RECORD_CSV_HEADER.split(",").at(-1), "asked_through");
    assert.equal(cells.at(-1), mainHbTitle);
    const theirs = await userPolicyTranscript(spaceReaderId, spaceReader);
    const spaceRow = theirs!.current.find((x) => x.document_id === policy.id)!;
    assert.equal(spaceRow.via_handbook, null);
    assert.equal(spaceRow.space_name, spaceName);
    assert.equal(recordCsvCells(spaceRow).at(-1), "");
  });

  test("a viewer outside the handbook's audience reads asked_through_handbook, never the title: team view, record, roster, queue, CSV", async () => {
    // The team view (and /api/compliance/team's JSON, which spreads these rows).
    const team = (await teamPolicyRows([readersGroup], outsiderId)).find((x) => x.user_id === readerId && x.document_id === policy.id);
    assert.ok(team, "the outsider leads the readers' group and reads the space: the row is theirs to see");
    assert.equal(team!.via_handbook_title, null, "the handbook's title stays with its audience");
    assert.equal(team!.asked_through_handbook, true);

    // Someone else's record: neither the title nor the handbook's id, the CSV cell unnamed.
    const theirs = await userPolicyTranscript(readerId, outsider);
    assert.ok(theirs, "the outsider may open the reader's record");
    assert.notEqual(theirs!.viewer_kind, "self");
    const row = theirs!.current.find((x) => x.document_id === policy.id)!;
    assert.ok(row, "the policy is on the record");
    assert.equal(row.via_handbook, null);
    assert.equal(row.via_handbook_title, null);
    assert.equal(row.asked_through_handbook, true);
    assert.equal(recordCsvCells(row).at(-1), ASKED_THROUGH_UNNAMED);
    assert.ok(!JSON.stringify(theirs).includes(mainHbTitle), "the title appears nowhere in the record's JSON");

    // The roster (the Record tab, its CSV and the matrix CSV) and the portal's queue.
    const roster = (await ackStatusForDocument(policy.id, outsiderId)).find((x) => x.id === readerId)!;
    assert.equal(roster.via_handbook_title, null);
    assert.equal(roster.asked_through_handbook, true);
    assert.equal(askedThroughCell(roster), "a handbook");
    const q = (await policyNeedsAttention(200, { documentIds: [policy.id], viewerId: outsiderId })).rows.find(
      (x) => x.user_id === readerId && x.reason === "overdue"
    );
    assert.ok(q);
    assert.equal(q!.via_handbook_title, null);
    assert.equal(q!.asked_through_handbook, true);

    // A viewer in the audience sees the title on the same record.
    const inAudience = (await userPolicyTranscript(readerId, spaceReader))!.current.find((x) => x.document_id === policy.id)!;
    assert.equal(inAudience.via_handbook_title, mainHbTitle);
    assert.deepEqual(inAudience.via_handbook, { id: mainHb, title: mainHbTitle });
    assert.equal(recordCsvCells(inAudience).at(-1), mainHbTitle);
    // And the person themself.
    const own = (await userPolicyTranscript(readerId, reader))!.current.find((x) => x.document_id === policy.id)!;
    assert.equal(own.via_handbook_title, mainHbTitle);
    assert.equal(own.asked_through_handbook, true);

    // Managing the handbook names it too (handbook.manage held globally: the workspace handbook's owner).
    const role = await createRole({ name: `Handbook builder ${STAMP}`, permissions: ["handbook.manage"] });
    assert.ok("id" in role, "the role exists");
    roleIds.push(role.id);
    assert.deepEqual(await assignRole({ roleId: role.id, userId: outsiderId }), { ok: true });
    try {
      const managed = (await teamPolicyRows([readersGroup], outsiderId)).find((x) => x.user_id === readerId && x.document_id === policy.id);
      assert.equal(managed!.via_handbook_title, mainHbTitle, "a manager of the handbook sees its title");
      assert.equal((await ackStatusForDocument(policy.id, outsiderId)).find((x) => x.id === readerId)!.via_handbook_title, mainHbTitle);
    } finally {
      await pool().query("DELETE FROM role_assignments WHERE user_id = $1 AND role_id = $2", [outsiderId, role.id]);
    }
  });

  test("the tag: named for a viewer who may see the handbook, unnamed otherwise, \"you\" on the person's own record", async () => {
    const tag = await import("../src/components/handbooks/ThroughHandbookTag");
    assert.equal(
      tag.throughHandbookTip("Employee Handbook"),
      "Asked through Employee Handbook: they can't open this policy's space, so reminders link to the handbook."
    );
    assert.equal(
      tag.throughHandbookTip("Employee Handbook", { self: true }),
      "Asked through Employee Handbook: you can't open this policy's space, so reminders link to the handbook."
    );
    assert.equal(
      tag.THROUGH_UNNAMED_HANDBOOK_TIP,
      "Asked through a handbook you can't open: they can't open this policy's space, so reminders link to the handbook."
    );
    assert.equal(tag.ThroughHandbookTag({ title: null }), null, "nothing without a title or the flag");
    assert.notEqual(tag.ThroughHandbookTag({ title: null, asked: true }), null, "the flag alone renders the tag");
  });

  test("{{handbook_line}} in a subject reads as plain text; the body keeps its bold", async () => {
    const { previewEmail, templateDef } = await import("../src/lib/email-templates");
    const out = await previewEmail("ack_due", "{{status_label}}: {{doc_title}}. {{handbook_line}}", templateDef("ack_due")!.body, ORIGIN);
    assert.equal(out.subject, "Due soon: Acceptable Use Policy. It's in Employee Handbook.", "no markdown asterisks in a subject");
    assert.ok(out.html.includes("<strong>Employee Handbook</strong>"), out.html);
  });

  test("the record links a handbook-only policy into the handbook on the person's own record only", async () => {
    const { recordPolicyHref } = await import("../src/components/compliance/PersonRecord");
    assert.equal(recordPolicyHref(policy.id, { id: mainHb }, true), `/handbooks/${mainHb}/${policy.id}#confirm-reading`);
    assert.equal(recordPolicyHref(policy.id, { id: mainHb }, false), `/doc/${policy.id}`, "someone else viewing keeps the document");
    assert.equal(recordPolicyHref(policy.id, null, true), `/doc/${policy.id}`);
  });

  test("unpublishing the handbook takes the policy away from the reader's lists and notices; the space reader keeps it", async () => {
    // Only the main handbook and the later one admit the reader; take both down.
    await pool().query("UPDATE handbooks SET status = 'draft' WHERE id = ANY($1) AND title LIKE $2", [handbookIds, `${STAMP} %`]);
    try {
      const scope = await scopeOf(reader);
      assert.ok(!(await listMyPolicies(readerId, scope)).some((r) => docIds.includes(r.id)), "off My policies at once");
      assert.ok(!(await listPendingAcksFor(readerId, scope)).some((r) => docIds.includes(r.id)));
      assert.ok(!(await compliancePendingUsers(policy.id)).some((u) => u.id === readerId), "no notice reaches them");
      assert.equal(await stampAckReminded(policy.id, [readerId]), 0);
      assert.equal((await ackHandbookRoutes([{ document_id: policy.id, user_id: readerId }])).size, 0, "no link into a draft");
      assert.ok(!(await teamPolicyRows([readersGroup], spaceReaderId)).some((x) => x.user_id === readerId && x.document_id === policy.id));
      const space = await scopeOf(spaceReader);
      assert.ok((await listMyPolicies(spaceReaderId, space)).some((r) => r.id === policy.id && r.via_handbook === null));
    } finally {
      await pool().query("UPDATE handbooks SET status = 'published' WHERE id = ANY($1) AND title <> $2", [handbookIds, `${STAMP} Draft handbook`]);
    }
  });
});

// SOPs in handbooks (1.18.2): a handbook holds policies, SOPs or both (and,
// through "All types", any other published document), and every count,
// position and sentence names what it holds. A handbook of policies only
// keeps the 1.18.0 words byte for byte (the whole-handbook statement is
// stored on attestation records); SOPs only say SOPs; a mix counts each
// kind ("2 policies and 2 SOPs") and numbers "Document k of N".
//
// Confirmation is per document, whatever its type: an SOP that requires
// confirmation is counted and confirmed by the whole-handbook POST exactly
// as a policy is, and one that does not is "For information".
//
// Fixtures are this file's own: one private space granted to this file's
// group (a reader, and an editor who builds handbooks there through a
// space-scoped custom role, no admin account), handbooks whose audience is
// that group, and lib/ee stubbed to grant policy_ack (test/support/ee-stub).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/handbook-sop.test.ts

import { edition } from "./support/ee-stub";
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, createDocument, createSpace, createRole, assignRole, deleteRole, setSpaceGroups } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { switchOn } from "./support/assign";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";
import {
  handbookItemsLabel,
  handbookKind,
  handbookPositionLabel,
  handbookTypeCounts,
  nextItemLabel,
  type HandbookTypeCounts,
} from "../src/lib/handbook-shared";
import {
  confirmButtonLabel,
  confirmItemPrefix,
  confirmStale,
  CONFIRM_STALE,
  handbookStatement,
  handbookStatementFor,
  ownStatementsIntro,
  OWN_STATEMENTS_INTRO,
} from "../src/lib/handbook-confirm-shared";
import { countLine, itemsNoun, positionLine } from "../src/components/handbooks/print/print-model";
import type { DocType, SessionUser } from "../src/lib/types";

const STAMP = `HBSOP${Date.now().toString(36)}`;

let data: typeof import("../src/components/handbooks/reader/reader-data");
let hb: typeof import("../src/lib/handbooks");
let confirm: typeof import("../src/lib/handbook-confirm");

let reader: SessionUser;
let editor: SessionUser;
let spaceId = 0;
let groupId = 0;
let roleId = 0;
const userIds: number[] = [];
const docIds: number[] = [];
const handbookIds: number[] = [];
const docs: Record<string, number> = {};

async function makeUser(name: string): Promise<SessionUser> {
  const r = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`,
    [`${STAMP.toLowerCase()}_${name}`, `${STAMP} ${name}`, `${STAMP.toLowerCase()}_${name}@example.test`]
  );
  userIds.push(r.rows[0].id);
  return { id: r.rows[0].id, username: `${STAMP.toLowerCase()}_${name}`, name: `${STAMP} ${name}`, role: "viewer" } as unknown as SessionUser;
}

async function makeDoc(tag: string, type: DocType, required: boolean): Promise<number> {
  const d = await createDocument({
    space_id: spaceId,
    title: `${STAMP} ${tag}`,
    type,
    status: "published",
    content: `# ${tag}\n\nStaff must follow this.`,
    summary: "",
    tags: [],
    author: "test",
  } as Parameters<typeof createDocument>[0]);
  docIds.push(d.id);
  docs[tag] = d.id;
  if (required) await switchOn(d.id, { editDefault: null, recertMonths: null });
  return d.id;
}

/** A published workspace handbook for this file's group, confirm the whole handbook on, one section holding `ids` in order. */
async function makeHandbook(title: string, ids: number[]): Promise<number> {
  const h = await fixtureQuery(
    `INSERT INTO handbooks (title, status, audience, confirm_whole, created_by_name, published_at)
     VALUES ($1, 'published', 'groups', 1, 'test', now()) RETURNING id`,
    [`${STAMP} ${title}`]
  );
  const id = h.rows[0].id as number;
  handbookIds.push(id);
  await pool().query("INSERT INTO handbook_audience (handbook_id, group_id) VALUES ($1, $2)", [id, groupId]);
  const sec = await pool().query("INSERT INTO handbook_sections (handbook_id, title, position) VALUES ($1, 'Working here', 0) RETURNING id", [id]);
  for (const [i, docId] of ids.entries()) {
    await pool().query("INSERT INTO handbook_items (handbook_id, section_id, document_id, position) VALUES ($1, $2, $3, $4)", [
      id,
      sec.rows[0].id,
      docId,
      i,
    ]);
  }
  return id;
}

async function view(user: SessionUser, handbookId: number, docId: number) {
  const policy = await hb.getHandbookPolicy(user, handbookId, docId);
  assert.ok(policy, `handbook ${handbookId} opens document ${docId}`);
  const base = await data.loadReaderBase(user, policy.handbook, SETTINGS_DEFAULTS);
  const v = await data.loadPolicyView(user, base, policy, SETTINGS_DEFAULTS);
  return { base, v };
}

before(async () => {
  data = await import("../src/components/handbooks/reader/reader-data");
  hb = await import("../src/lib/handbooks");
  confirm = await import("../src/lib/handbook-confirm");
  const space = await createSpace({ slug: `${STAMP.toLowerCase()}-ops`, name: `${STAMP} Operations`, visibility: "private" });
  spaceId = space.id;
  reader = await makeUser("reader");
  editor = await makeUser("editor");
  const g = await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Operations staff`]);
  groupId = g.rows[0].id;
  for (const u of [reader, editor]) await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, u.id]);
  await setSpaceGroups(spaceId, [groupId]);
  const role = await createRole({ name: `${STAMP} Handbook builder`, permissions: ["handbook.manage"] });
  assert.ok("id" in role, "custom role created");
  roleId = role.id;
  await assignRole({ roleId, userId: editor.id, spaceId });

  await makeDoc("Leave policy", "policy", true);
  await makeDoc("Security policy", "policy", true);
  await makeDoc("Opening the store", "sop", true); // an SOP that asks to be confirmed
  await makeDoc("Restocking shelves", "sop", false); // an SOP for information
  await makeDoc("Store floor plan", "knowledge", false);
});

after(async () => {
  edition.features = ["policy_ack"];
  await fixtureQuery("DELETE FROM handbook_confirmations WHERE handbook_id = ANY($1) OR user_id = ANY($2)", [handbookIds, userIds]);
  await fixtureQuery("DELETE FROM audit_log WHERE target_type = 'handbook' AND target_id = ANY($1)", [handbookIds.map(String)]);
  await fixtureQuery("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM handbooks WHERE id = ANY($1) OR title LIKE $2", [handbookIds, `${STAMP}%`]);
  await fixtureQuery("DELETE FROM audit_log WHERE target_type = 'document' AND target_id = ANY($1)", [docIds.map(String)]);
  for (const table of ["acknowledgements", "ack_decisions", "ack_notices", "ack_outbox", "attested_texts", "policy_assignments", "doc_views"]) {
    await fixtureQuery(`DELETE FROM ${table} WHERE document_id = ANY($1)`, [docIds]);
  }
  await fixtureQuery("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await fixtureQuery("DELETE FROM role_assignments WHERE role_id = $1", [roleId]);
  if (roleId) await deleteRole(roleId);
  await fixtureQuery("DELETE FROM group_members WHERE group_id = $1", [groupId]);
  await fixtureQuery("DELETE FROM groups WHERE id = $1", [groupId]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM spaces WHERE id = $1", [spaceId]);
  await pool().end();
});

// --- The wording, pure ----------------------------------------------------------------

const mix = (policy: number, sop: number, other = 0): HandbookTypeCounts => ({ policy, sop, other });

describe("naming what a handbook holds", () => {
  test("policies only (and empty) keep the 1.18.0 words exactly", () => {
    assert.equal(handbookItemsLabel(mix(8, 0)), "8 policies");
    assert.equal(handbookItemsLabel(mix(1, 0)), "1 policy");
    assert.equal(handbookItemsLabel(mix(0, 0)), "0 policies");
    assert.equal(handbookPositionLabel(mix(8, 0), 3), "Policy 3 of 8");
    assert.equal(confirmButtonLabel(5, mix(5, 0)), "Confirm 5 policies");
    assert.equal(confirmButtonLabel(5), "Confirm 5 policies", "the old call still answers");
    assert.equal(confirmButtonLabel(0, mix(0, 0)), "Confirm the handbook");
    // The stored sentence: byte-identical, with or without the mix.
    const old = "I have read and understood all 8 policies in Employee Handbook 2026, and I agree to follow them.";
    assert.equal(handbookStatement("Employee Handbook 2026", 8), old);
    assert.equal(handbookStatement("Employee Handbook 2026", 8, mix(8, 0)), old);
    assert.equal(handbookStatementFor("Employee Handbook 2026", Array.from({ length: 8 }, () => ({ type: "policy" as const }))), old);
    assert.equal(
      handbookStatement("H", 1, mix(1, 0)),
      "I have read and understood the policy in H, and I agree to follow it."
    );
    assert.equal(ownStatementsIntro(mix(2, 0)), OWN_STATEMENTS_INTRO);
    assert.equal(confirmStale(mix(3, 0)), CONFIRM_STALE);
    assert.equal(countLine(8, 3, mix(8, 0)), "8 policies · 3 sections");
    assert.equal(positionLine({ policyCount: 8, mix: mix(8, 0) }, 2), "Policy 2 of 8");
    assert.equal(positionLine({ policyCount: 8 }, 2), "Policy 2 of 8", "no mix: the policy words");
  });

  test("SOPs only say SOPs", () => {
    assert.equal(handbookKind(mix(0, 4)), "sop");
    assert.equal(handbookItemsLabel(mix(0, 4)), "4 SOPs");
    assert.equal(handbookItemsLabel(mix(0, 1)), "1 SOP");
    assert.equal(handbookPositionLabel(mix(0, 4), 2), "SOP 2 of 4");
    assert.equal(confirmButtonLabel(2, mix(0, 2)), "Confirm 2 SOPs");
    assert.equal(handbookStatement("Store SOPs", 4, mix(0, 4)), "I have read and understood all 4 SOPs in Store SOPs, and I agree to follow them.");
    assert.equal(handbookStatement("Store SOPs", 1, mix(0, 1)), "I have read and understood the SOP in Store SOPs, and I agree to follow it.");
    assert.equal(ownStatementsIntro(mix(0, 2)), "These SOPs ask you to confirm in their own words:");
    assert.match(confirmStale(mix(0, 2)), /^An SOP in this handbook changed/);
    assert.equal(countLine(4, 1, mix(0, 4)), "4 SOPs · 1 section");
  });

  test("a mix counts each kind and numbers documents", () => {
    assert.equal(handbookKind(mix(3, 2)), "document");
    assert.equal(handbookItemsLabel(mix(3, 2)), "3 policies and 2 SOPs");
    assert.equal(handbookItemsLabel(mix(1, 1)), "1 policy and 1 SOP");
    assert.equal(handbookPositionLabel(mix(3, 2), 2), "Document 2 of 5");
    assert.equal(confirmButtonLabel(3, mix(2, 1)), "Confirm 2 policies and 1 SOP");
    assert.equal(
      handbookStatement("Employee Handbook", 5, mix(3, 2)),
      "I have read and understood all 5 documents in Employee Handbook (3 policies and 2 SOPs), and I agree to follow them."
    );
    assert.equal(ownStatementsIntro(mix(1, 1)), "These documents ask you to confirm in their own words:");
    assert.match(confirmStale(mix(1, 1)), /^A document in this handbook changed/);
    assert.equal(countLine(5, 2, mix(3, 2)), "3 policies and 2 SOPs · 2 sections");
  });

  test("other types are documents in a mix, and alone", () => {
    assert.deepEqual(handbookTypeCounts(["policy", "policy", "policy", "sop", "sop", "technical"]), mix(3, 2, 1));
    assert.equal(handbookItemsLabel(mix(3, 2, 1)), "3 policies, 2 SOPs and 1 other document");
    assert.equal(handbookItemsLabel(mix(3, 0, 2)), "3 policies and 2 other documents");
    assert.equal(handbookItemsLabel(mix(0, 1, 1)), "1 SOP and 1 other document");
    assert.equal(handbookItemsLabel(mix(0, 0, 4)), "4 documents");
    assert.equal(handbookPositionLabel(mix(0, 0, 4), 1), "Document 1 of 4");
    assert.equal(
      handbookStatement("Mixed", 6, mix(3, 2, 1)),
      "I have read and understood all 6 documents in Mixed (3 policies, 2 SOPs and 1 other document), and I agree to follow them."
    );
    assert.equal(handbookStatement("Guides", 4, mix(0, 0, 4)), "I have read and understood all 4 documents in Guides, and I agree to follow them.");
    // A locked placeholder never gives its type away.
    assert.deepEqual(handbookTypeCounts([{ type: "sop", restricted: true }, { type: "policy" }]), mix(1, 0, 1));
  });
});

describe("the 1.18.2 review's wording", () => {
  test("a total of two is 'both' for SOPs and mixes; policies only keep 'all 2 policies'", () => {
    assert.equal(handbookStatement("H", 2), "I have read and understood all 2 policies in H, and I agree to follow them.");
    assert.equal(handbookStatement("H", 2, mix(2, 0)), "I have read and understood all 2 policies in H, and I agree to follow them.");
    assert.equal(handbookStatement("H", 2, mix(0, 2)), "I have read and understood both SOPs in H, and I agree to follow them.");
    assert.equal(
      handbookStatement("H", 2, mix(1, 1)),
      "I have read and understood both documents in H (1 policy and 1 SOP), and I agree to follow them."
    );
    assert.equal(
      handbookStatement("H", 2, mix(0, 1, 1)),
      "I have read and understood both documents in H (1 SOP and 1 other document), and I agree to follow them."
    );
    assert.equal(handbookStatement("H", 2, mix(0, 0, 2)), "I have read and understood both documents in H, and I agree to follow them.");
    assert.equal(
      handbookStatement("H", 3, mix(1, 1, 1)),
      "I have read and understood all 3 documents in H (1 policy, 1 SOP and 1 other document), and I agree to follow them."
    );
  });

  test("the confirm list's screen-reader prefix names each item's own kind; the number is the handbook's", () => {
    const m = mix(2, 1, 1);
    assert.equal(confirmItemPrefix(m, 1, "policy"), "Policy 1: ");
    assert.equal(confirmItemPrefix(m, 3, "sop"), "SOP 3: ");
    assert.equal(confirmItemPrefix(m, 4, "knowledge"), "Document 4: ");
    assert.equal(confirmItemPrefix(mix(3, 0), 2, "policy"), "Policy 2: ", "policies only: as before");
    assert.equal(confirmItemPrefix(m, 3), "Document 3: ", "without the item's type, the handbook's kind");
  });

  test("the reader's Next label names the handbook's kind", () => {
    assert.equal(nextItemLabel(handbookKind(mix(4, 0))), "Next policy");
    assert.equal(nextItemLabel(handbookKind(mix(0, 3))), "Next SOP");
    assert.equal(nextItemLabel(handbookKind(mix(2, 1))), "Next document");
  });

  test("the printed acknowledgement's noun: 'policies' for policies only however many, else counted", () => {
    assert.equal(itemsNoun({ policyCount: 1 }), "policies", "the 1.18.0 page printed the plural for one policy");
    assert.equal(itemsNoun({ policyCount: 1, mix: mix(1, 0) }), "policies");
    assert.equal(itemsNoun({ policyCount: 3, mix: mix(3, 0) }), "policies");
    assert.equal(itemsNoun({ policyCount: 1, mix: mix(0, 1) }), "SOP");
    assert.equal(itemsNoun({ policyCount: 2, mix: mix(0, 2) }), "SOPs");
    assert.equal(itemsNoun({ policyCount: 1, mix: mix(0, 0, 1) }), "document");
    assert.equal(itemsNoun({ policyCount: 2, mix: mix(1, 1) }), "documents");
  });
});

// --- Against the database ----------------------------------------------------------------

describe("SOPs in a handbook", () => {
  test("the Add documents search filters to SOPs; All types lists policies, then SOPs, then the rest", async () => {
    const draft = await hb.createHandbook(editor, {
      title: `${STAMP} Draft`,
      space_id: spaceId,
      introduction: "",
      audience: "groups",
      group_ids: [groupId],
      confirm_whole: false,
      require_signature: false,
    });
    handbookIds.push(draft.id);
    const sops = await hb.handbookCandidates(editor, draft.id, { q: STAMP, type: "sop" });
    assert.deepEqual(sops.map((c) => c.id).sort((a, b) => a - b), [docs["Opening the store"], docs["Restocking shelves"]].sort((a, b) => a - b));
    assert.ok(sops.every((c) => c.type === "sop"));
    const policies = await hb.handbookCandidates(editor, draft.id, { q: STAMP });
    assert.ok(policies.length === 2 && policies.every((c) => c.type === "policy"), "policies stay the default");
    const all = await hb.handbookCandidates(editor, draft.id, { q: STAMP, type: "all" });
    assert.deepEqual(
      all.map((c) => c.type),
      ["policy", "policy", "sop", "sop", "knowledge"],
      "policies first, then SOPs, then the rest"
    );
    // The editor's own list row names the kinds once SOPs are in.
    const filled = await hb.addHandbookItems(editor, draft.id, [docs["Leave policy"], docs["Opening the store"]]);
    assert.deepEqual(filled.item_types, { policy: 1, sop: 1, other: 0 });
    assert.equal(handbookItemsLabel(filled.item_types), "1 policy and 1 SOP");
    const listed = (await hb.listHandbooks(editor)).find((h) => h.id === draft.id);
    assert.ok(listed);
    assert.deepEqual(listed.item_types, { policy: 1, sop: 1, other: 0 });
  });

  test("a mixed handbook's reader says what it holds; an SOP shows as an SOP and confirms like a policy", async () => {
    const id = await makeHandbook("Store handbook", [
      docs["Leave policy"],
      docs["Security policy"],
      docs["Opening the store"],
      docs["Restocking shelves"],
    ]);
    const asks = await view(reader, id, docs["Opening the store"]);
    assert.ok(asks.base.subtitle.startsWith("2 policies and 2 SOPs in 1 section · updated "), asks.base.subtitle);
    assert.deepEqual(asks.base.mix, { policy: 2, sop: 2, other: 0 });
    assert.equal(asks.v.type, "sop", "the masthead's TypeBadge gets the SOP type");
    assert.equal(asks.v.position, "Document 3 of 4");
    assert.equal(asks.v.noun, "sop");
    assert.equal(asks.v.handbookNoun, "document", "the bar's Next names what the handbook holds");
    assert.equal(nextItemLabel(asks.v.handbookNoun), "Next document");
    const leave = await view(reader, id, docs["Leave policy"]);
    assert.equal(leave.v.noun, "policy");
    assert.equal(nextItemLabel(leave.v.handbookNoun), "Next document", "not the policy on screen: the next is an SOP");
    assert.equal(asks.v.standing, "to_confirm", "an SOP that requires confirmation asks the reader");
    assert.ok(asks.v.ackSeed, "its confirm bar is seeded");
    assert.equal(asks.v.confirm.forInformation, false);
    assert.equal(asks.base.contents[0].items[2].type, "sop");
    assert.deepEqual(asks.base.progress, { confirmed: 0, total: 3 }, "both policies and the SOP that asks count");
    const info = await view(reader, id, docs["Restocking shelves"]);
    assert.equal(info.v.standing, null);
    assert.equal(info.v.confirm.forInformation, true, "an SOP that does not ask is For information");
  });

  test("confirming the mixed handbook counts and confirms the SOP that asks, names the mix, and leaves the other SOP alone", async () => {
    const ids = [docs["Leave policy"], docs["Security policy"], docs["Opening the store"], docs["Restocking shelves"]];
    const id = await makeHandbook("Store handbook to confirm", ids);
    const view1 = await confirm.loadConfirmView(reader, id);
    assert.ok(view1);
    assert.deepEqual(view1.counts, { total: 4, confirmed: 0, to_confirm: 3, updated: 0, info: 1, outstanding: 3 });
    assert.deepEqual(view1.items.map((i) => i.type), ["policy", "policy", "sop", "sop"]);
    const standing = Object.fromEntries(view1.items.map((i) => [i.doc_id, i.standing]));
    assert.equal(standing[docs["Opening the store"]], "to_confirm");
    assert.equal(standing[docs["Restocking shelves"]], "info");
    const statement = `I have read and understood all 4 documents in ${STAMP} Store handbook to confirm (2 policies and 2 SOPs), and I agree to follow them.`;
    assert.equal(view1.statement, statement);
    const waiting = view1.items.filter((i) => i.standing === "to_confirm" || i.standing === "updated");
    assert.equal(confirmButtonLabel(view1.counts.outstanding, handbookTypeCounts(waiting)), "Confirm 2 policies and 1 SOP");

    const versions = Object.fromEntries(waiting.map((i) => [i.doc_id, i.version_id]));
    const r = await confirm.confirmHandbook(
      reader,
      id,
      { agreed: true, versions, statement: view1.statement, fingerprint: view1.handbook.fingerprint },
      { ip: "203.0.113.77", userAgent: "HandbookSopTest/1.0" }
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.ok);
    assert.equal(r.confirmed, 3);
    assert.equal(r.handbook_confirmed, true);
    const rows = await pool().query<{ document_id: number; statement_text: string }>(
      "SELECT document_id, statement_text FROM acknowledgements WHERE user_id = $1 AND document_id = ANY($2) ORDER BY document_id",
      [reader.id, ids]
    );
    assert.deepEqual(
      rows.rows.map((x) => x.document_id).sort((a, b) => a - b),
      [docs["Leave policy"], docs["Security policy"], docs["Opening the store"]].sort((a, b) => a - b),
      "the SOP that asks is confirmed; the one for information is not"
    );
    assert.ok(rows.rows.every((x) => x.statement_text === statement), "every row stores the statement that names the mix");
    const after = await confirm.loadConfirmView(reader, id);
    assert.ok(after?.confirmed, "the handbook-level record is on file");
  });

  test("an SOP-only handbook says SOPs everywhere, and a handbook with other types counts them as documents", async () => {
    const sopOnly = await makeHandbook("Store SOPs", [docs["Opening the store"], docs["Restocking shelves"]]);
    const s = await view(reader, sopOnly, docs["Restocking shelves"]);
    assert.ok(s.base.subtitle.startsWith("2 SOPs in 1 section · "), s.base.subtitle);
    assert.equal(s.v.position, "SOP 2 of 2");
    assert.equal(nextItemLabel(s.v.handbookNoun), "Next SOP");
    const sv = await confirm.loadConfirmView(reader, sopOnly);
    assert.equal(sv?.statement, `I have read and understood both SOPs in ${STAMP} Store SOPs, and I agree to follow them.`);

    const withOther = await makeHandbook("Store binder", [docs["Leave policy"], docs["Opening the store"], docs["Store floor plan"]]);
    const o = await view(reader, withOther, docs["Store floor plan"]);
    assert.ok(o.base.subtitle.startsWith("1 policy, 1 SOP and 1 other document in 1 section · "), o.base.subtitle);
    assert.equal(o.v.position, "Document 3 of 3");
    assert.equal(o.v.noun, "document");
    const ov = await confirm.loadConfirmView(reader, withOther);
    assert.equal(
      ov?.statement,
      `I have read and understood all 3 documents in ${STAMP} Store binder (1 policy, 1 SOP and 1 other document), and I agree to follow them.`
    );
  });
});

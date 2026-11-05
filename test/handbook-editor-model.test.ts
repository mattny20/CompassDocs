// The handbook editor's working copy (1.18.0,
// components/handbooks/editor/model): the moves its buttons make must be the
// ones lib/handbooks makes on the server — up and down across a section
// edge, a removed section's policies kept in the previous one, ticking onto
// the end — and Save must send only what changed. Pure; no DATABASE_URL.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addItem,
  addSection,
  canMove,
  contentsPayload,
  detailsErrors,
  detailsPayload,
  findModeChanges,
  itemFromCandidate,
  itemFromHandbook,
  moveItem,
  removeItem,
  removeSection,
  setFindMode,
  type DraftItem,
  type DraftSection,
} from "../src/components/handbooks/editor/model";
import { HANDBOOK_RESTRICTED_ITEM } from "../src/lib/handbook-shared";

const item = (doc_id: number): DraftItem => ({
  doc_id,
  title: `Doc ${doc_id}`,
  type: "policy",
  doc_status: "published",
  space_name: "People Ops",
  space_icon: "",
  version: 1,
  version_at: null,
  find_mode: "space",
  restricted: false,
});

const two = (): DraftSection[] => [
  { key: "s1", id: 1, title: "Working here", items: [item(10), item(11)] },
  { key: "s2", id: 2, title: "Security", items: [item(20)] },
];

const order = (s: DraftSection[]) => s.map((x) => x.items.map((i) => i.doc_id));

describe("handbook editor model", () => {
  test("ticking appends to the last section, once; the first tick makes a section", () => {
    assert.deepEqual(order(addItem(two(), item(30))), [[10, 11], [20, 30]]);
    assert.deepEqual(order(addItem(two(), item(10))), [[10, 11], [20]]);
    const first = addItem([], item(5));
    assert.equal(first.length, 1);
    assert.equal(first[0].title, "Policies");
    assert.deepEqual(order(first), [[5]]);
  });

  test("moves cross section edges and stop at the handbook's ends", () => {
    assert.deepEqual(order(moveItem(two(), 11, "down")), [[10], [11, 20]]);
    assert.deepEqual(order(moveItem(two(), 20, "up")), [[10, 11, 20], []]);
    assert.deepEqual(order(moveItem(two(), 10, "down")), [[11, 10], [20]]);
    assert.deepEqual(order(moveItem(two(), 10, "up")), [[10, 11], [20]]);
    assert.deepEqual(order(moveItem(two(), 20, "down")), [[10, 11], [20]]);
    assert.equal(canMove(two(), 10, "up"), false);
    assert.equal(canMove(two(), 20, "down"), false);
    assert.equal(canMove(two(), 11, "down"), true);
    // An empty section still takes an item across its edge.
    const withEmpty = addSection(two(), "Money");
    assert.equal(canMove(withEmpty, 20, "down"), true);
    assert.deepEqual(order(moveItem(withEmpty, 20, "down")), [[10, 11], [], [20]]);
  });

  test("removing a section keeps its policies in the previous one (the next for the first); the last stays", () => {
    assert.deepEqual(order(removeSection(two(), "s2")), [[10, 11, 20]]);
    assert.deepEqual(order(removeSection(two(), "s1")), [[10, 11, 20]]);
    const one = removeSection(two(), "s2");
    assert.equal(removeSection(one, "s1"), one);
  });

  test("the contents payload keeps saved ids and leaves them off new sections", () => {
    const s = addSection(removeItem(two(), 11), "Money");
    assert.deepEqual(contentsPayload(s), {
      sections: [
        { id: 1, title: "Working here", doc_ids: [10] },
        { id: 2, title: "Security", doc_ids: [20] },
        { title: "Money", doc_ids: [] },
      ],
    });
  });

  test("only changed find modes are sent; a new policy counts from 'space'", () => {
    const saved = {
      sections: [{ items: [{ doc_id: 10, find_mode: "space" }, { doc_id: 11, find_mode: "handbook_only" }] }],
    } as unknown as Parameters<typeof findModeChanges>[0];
    let s = setFindMode(two(), 10, "handbook_only");
    s = setFindMode(s, 11, "handbook_only");
    s = setFindMode(s, 20, "handbook_only");
    assert.deepEqual(findModeChanges(saved, s), [
      { doc_id: 10, mode: "handbook_only" },
      { doc_id: 20, mode: "handbook_only" },
    ]);
  });

  test("details: title and groups are required; the signature needs whole-handbook confirmation", () => {
    const d = {
      title: "  ",
      owner: "4",
      introduction: "",
      audience: "groups" as const,
      group_ids: [],
      confirm_whole: false,
      require_signature: true,
    };
    const e = detailsErrors(d);
    assert.ok(e.title);
    assert.ok(e.groups);
    const p = detailsPayload({ ...d, title: " Handbook ", group_ids: [3] });
    assert.equal(p.title, "Handbook");
    assert.equal(p.space_id, 4);
    assert.equal(p.require_signature, false);
    assert.deepEqual(detailsPayload({ ...d, audience: "all", group_ids: [3] }).group_ids, []);
    assert.equal(detailsPayload({ ...d, owner: "" }).space_id, null);
  });

  test("a locked placeholder stays locked in the working copy, moves and is removed like any item; a ticked candidate never is one", () => {
    const placeholder = itemFromHandbook({
      doc_id: 40,
      title: HANDBOOK_RESTRICTED_ITEM,
      type: "policy",
      doc_status: "published",
      space_name: "",
      space_icon: "",
      version: null,
      version_at: null,
      find_mode: "handbook_only",
      restricted: true,
    } as unknown as Parameters<typeof itemFromHandbook>[0]);
    assert.equal(placeholder.restricted, true);
    assert.equal(placeholder.title, HANDBOOK_RESTRICTED_ITEM);
    const s: DraftSection[] = [{ key: "s1", id: 1, title: "Working here", items: [item(10), placeholder] }];
    const moved = moveItem(s, 40, "up");
    assert.deepEqual(order(moved), [[40, 10]]);
    assert.equal(moved[0].items[0].restricted, true, "a move keeps it locked");
    assert.deepEqual(contentsPayload(moved).sections[0].doc_ids, [40, 10], "Save sends it back by id");
    assert.deepEqual(order(removeItem(s, 40)), [[10]]);
    assert.equal(
      itemFromCandidate({ id: 9, title: "T", type: "policy", space_name: "S", space_icon: "", version: 1, updated_at: "" } as unknown as Parameters<
        typeof itemFromCandidate
      >[0]).restricted,
      false
    );
  });
});

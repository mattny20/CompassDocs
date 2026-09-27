// The org chart — pure rules.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOrgChart, chainAbove, teamBelow, peersOf, pathTo, managerField } from "../src/lib/directory-org";
import type { FieldLike, PersonLike } from "../src/lib/directory-display";

const field = (key: string, extra: Partial<FieldLike> = {}): FieldLike =>
  ({ key, label: key, kind: "text", multi: 0, builtin: 0, group_by: 0, options: [], value_format: "raw", display: "field", show_with: "", highlight: 0, inverse_label: "", show_in_card: 1, ...extra }) as FieldLike;
const fields = [
  field("title", { builtin: 1, options: [{ value: "CEO" }, { value: "VP" }, { value: "Manager" }, { value: "Analyst" }] }),
  field("manager", { kind: "people", label: "Reports to", inverse_label: "Direct reports" }),
];
let nextId = 1;
const person = (name: string, title: string, managerId?: number, id = nextId++): PersonLike =>
  ({ id, name, title, department: "", email: "", phone: "", mobile: "", office: "", custom: {}, links: managerId ? { manager: [{ id: managerId, name: `#${managerId}` }] } : {}, linked_by: {} }) as PersonLike;

describe("org chart", () => {
  test("builds the tree, orders reports by title then name, sizes subtrees, and counts heads and leaves", () => {
    const ceo = person("Zed Chief", "CEO");
    const vp1 = person("Ann Vice", "VP", ceo.id);
    const vp2 = person("Bob Vice", "VP", ceo.id);
    const mgr = person("Cy Lead", "Manager", vp1.id);
    const a1 = person("Dee Doer", "Analyst", mgr.id);
    const a2 = person("Al Doer", "Analyst", mgr.id);
    const lone = person("Solo Person", "Analyst");
    const chart = buildOrgChart([lone, a2, a1, mgr, vp2, vp1, ceo], fields);
    assert.deepEqual(chart.roots.map((r) => r.person.name), ["Zed Chief", "Solo Person"], "heads before people standing alone");
    const top = chart.roots[0];
    assert.deepEqual(top.reports.map((r) => r.person.name), ["Ann Vice", "Bob Vice"]);
    assert.deepEqual(top.reports[0].reports[0].reports.map((r) => r.person.name), ["Al Doer", "Dee Doer"]);
    assert.equal(top.size, 5);
    assert.equal(top.reports[0].size, 3);
    assert.equal(chart.byId.get(a1.id)!.depth, 3);
    assert.equal(chart.heads, 1);
    assert.equal(chart.leaves, 3);
    assert.deepEqual(chart.cycles, []);
    assert.deepEqual(chainAbove(chart, a1.id).map((p) => p.name), ["Cy Lead", "Ann Vice", "Zed Chief"]);
    assert.deepEqual(pathTo(chart, a1.id), [ceo.id, vp1.id, mgr.id, a1.id]);
    assert.deepEqual(teamBelow(chart, vp1.id).map((l) => [l.level, l.people.map((p) => p.name)]), [[1, ["Cy Lead"]], [2, ["Al Doer", "Dee Doer"]]]);
    assert.deepEqual(peersOf(chart, a1.id).map((p) => p.name), ["Al Doer"]);
    assert.deepEqual(peersOf(chart, ceo.id), []);
    assert.deepEqual(teamBelow(chart, lone.id), []);
  });

  test("a loop is broken at its lowest id, reported once, and never followed", () => {
    nextId = 10;
    const a = person("A", "Manager", 12); // 10 → 12
    const b = person("B", "Manager", 10); // 11 → 10
    const c = person("C", "Manager", 11); // 12 → 11
    const d = person("D", "Analyst", 11); // hangs off the loop
    const chart = buildOrgChart([a, b, c, d], fields);
    assert.deepEqual(chart.cycles, [[10, 12, 11]]);
    assert.equal(chart.managerOf.get(10), undefined, "the lowest id becomes the root");
    assert.deepEqual(chart.roots.map((r) => r.person.name), ["A"]);
    // 12 → 11 → 10, so A heads the tree, B is under A, C and D under B.
    assert.deepEqual(chainAbove(chart, d.id).map((p) => p.name), ["B", "A"]);
    assert.deepEqual(chart.roots[0].reports[0].reports.map((r) => r.person.name), ["C", "D"]);
    assert.equal(chart.roots[0].size, 3);
  });

  test("a link to someone not in the list (hidden) or to oneself is ignored", () => {
    nextId = 20;
    const x = person("X", "VP", 999);
    const y = person("Y", "Analyst", 21, 21);
    const chart = buildOrgChart([x, y], fields);
    assert.equal(chart.roots.length, 2);
    assert.equal(chart.managerOf.size, 0);
    assert.equal(managerField(fields)?.label, "Reports to");
    assert.equal(managerField([field("manager")]), undefined, "a text field keyed manager is not the org chart");
  });
});

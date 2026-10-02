// The reading surfaces drop a leading "# Title" that repeats the masthead
// (1.9.2, lib/drop-title). Matching heading removed; a different heading
// kept; a matching H1 that is not the first block kept; H2 never touched.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/drop-title.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dropLeadingTitle, sameTitle } from "../src/lib/drop-title";

const h = (depth: number, text: string) => ({ type: "heading", depth, children: [{ type: "text", value: text }] });
const p = (text: string) => ({ type: "paragraph", children: [{ type: "text", value: text }] });

test("a leading H1 that matches the title is dropped", () => {
  const tree = { type: "root", children: [h(1, "Production Deployment SOP"), p("Body")] };
  assert.equal(dropLeadingTitle(tree, "Production deployment SOP"), true);
  assert.deepEqual(tree.children.map((c: any) => c.type), ["paragraph"]);
});

test("a leading H1 with different words is kept", () => {
  const tree = { type: "root", children: [h(1, "Overview"), p("Body")] };
  assert.equal(dropLeadingTitle(tree, "Production deployment SOP"), false);
  assert.equal(tree.children.length, 2);
});

test("a matching H1 that is not the first block is kept", () => {
  const tree = { type: "root", children: [p("Intro"), h(1, "Production deployment SOP")] };
  assert.equal(dropLeadingTitle(tree, "Production deployment SOP"), false);
  assert.equal(tree.children.length, 2);
});

test("an H2 is never dropped, and an empty title drops nothing", () => {
  const tree = { type: "root", children: [h(2, "Title"), p("Body")] };
  assert.equal(dropLeadingTitle(tree, "Title"), false);
  const tree2 = { type: "root", children: [h(1, "Title")] };
  assert.equal(dropLeadingTitle(tree2, ""), false);
});

test("the match ignores case, punctuation and spacing but not words", () => {
  assert.equal(sameTitle("Q3  Plan: Draft!", "q3 plan draft"), true);
  assert.equal(sameTitle("Q3 Plan", "Q4 Plan"), false);
  assert.equal(sameTitle("", ""), false);
});

// The printed handbook's page boxes and wording (1.18.0, H5): the @page
// rules carry the handbook's title, the company and the reader's name, so
// they are escaped for a CSS string and for the <style> they are inlined
// into; each policy gets a named page with its running header; the cover
// has no furniture; the paper size follows the choice.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/handbook-print.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { cssString, handbookPageCss, policyPageName } from "../src/components/handbooks/print/page-css";
import {
  countLine,
  introFitsCover,
  sectionLabel,
  type PrintHandbook,
  type PrintPolicy,
} from "../src/components/handbooks/print/print-model";

const policy = (number: number, title: string): PrintPolicy => ({
  docId: 100 + number,
  number,
  title,
  typeLabel: "Policy",
  spaceName: "People Ops",
  version: 3,
  effectiveLabel: "Sep 1, 2026",
  owner: "Aisha Rahman",
  appliesTo: "",
  summaryPoints: [],
  content: "Body",
});

const hb = (over: Partial<PrintHandbook> = {}): PrintHandbook => ({
  id: 7,
  title: "Employee Handbook 2026",
  status: "published",
  introduction: "Welcome.",
  ownerLabel: "Acme Ltd",
  company: "Acme Ltd",
  logoUrl: "",
  sections: [
    { number: 1, title: "Working here", policies: [policy(1, "Code of Conduct"), policy(2, "Paid Time Off Policy")] },
    { number: 2, title: "Information security", policies: [policy(3, "Acceptable Use Policy")] },
  ],
  policyCount: 3,
  sectionCount: 2,
  printedOn: "Nov 5, 2026",
  printedBy: "Administrator",
  currentUrl: "https://docs.acme.com/handbooks/7",
  confirmOnline: true,
  paper: "a4",
  ...over,
});

test("cssString escapes quotes, backslashes, newlines and anything that could close the <style>", () => {
  assert.equal(cssString("Plain · title"), '"Plain · title"');
  const nasty = cssString('a"b\\c\nd</style><script>');
  assert.ok(!nasty.slice(1, -1).includes('"'), "no bare quote inside the string");
  assert.ok(!/[<>\n]/.test(nasty), "no <, > or newline survives");
  assert.ok(!/\\(?![0-9a-f]+ )/.test(nasty), "every backslash starts a hex escape");
  assert.equal(nasty, '"a\\22 b\\5c c\\a d\\3c /style\\3e \\3c script\\3e "');
});

test("the footer names the handbook, the company, the reader and the page number", () => {
  const css = handbookPageCss(hb());
  assert.match(css, /size: A4;/);
  assert.match(css, /@bottom-left \{ content: "Employee Handbook 2026 · Acme Ltd";/);
  assert.match(css, /@bottom-center \{ content: "Printed Nov 5, 2026 by Administrator · uncontrolled when printed";/);
  assert.match(css, /@bottom-right \{ content: "Page " counter\(page\);/);
  assert.match(css, /--hb-paper-height: 297mm/);
});

test("a draft says so in the footer of every page", () => {
  assert.match(handbookPageCss(hb({ status: "draft" })), /content: "Draft · Printed Nov 5, 2026/);
});

test("Letter paper sets the page size and the cover height", () => {
  const css = handbookPageCss(hb({ paper: "letter" }));
  assert.match(css, /size: letter;/);
  assert.match(css, /--hb-paper-height: 11in/);
});

test("the cover's page has no margin and no furniture", () => {
  const css = handbookPageCss(hb());
  const at = css.indexOf("@page hb-cover");
  const cover = css.slice(at, css.indexOf("\n}", at));
  assert.match(cover, /margin: 0;/);
  assert.equal((cover.match(/content: none/g) ?? []).length, 3);
});

test("each policy has a named page whose running header is its section and 'Policy k of N'", () => {
  const css = handbookPageCss(hb());
  for (const [n, section] of [
    [1, "1 · Working here"],
    [2, "1 · Working here"],
    [3, "2 · Information security"],
  ] as const) {
    const at = css.indexOf(`@page ${policyPageName(n)} {`);
    assert.ok(at >= 0, `policy ${n} has a page`);
    const rule = css.slice(at, css.indexOf("\n}", at));
    assert.match(rule, new RegExp(`@top-left \\{ content: "${section}";`));
    assert.match(rule, new RegExp(`@top-right \\{ content: "Policy ${n} of 3";`));
  }
});

test("an untitled section's running header falls back to the handbook's title", () => {
  const css = handbookPageCss(hb({ sections: [{ number: null, title: "", policies: [policy(1, "Only")] }], policyCount: 1 }));
  assert.match(css, /@page hb-p-1 \{\n  @top-left \{ content: "Employee Handbook 2026";/);
});

test("count line and section label read as the cover and contents print them", () => {
  assert.equal(countLine(8, 3), "8 policies · 3 sections");
  assert.equal(countLine(1, 1), "1 policy · 1 section");
  assert.equal(countLine(2, 0), "2 policies");
  assert.equal(sectionLabel({ number: 2, title: "Information security" }), "2 · Information security");
  assert.equal(sectionLabel({ number: null, title: "Other" }), "Other");
});

test("a short introduction sits on the cover; a long or structured one gets its own page", () => {
  assert.equal(introFitsCover(""), true);
  assert.equal(introFitsCover("Welcome to Acme. This handbook brings together the policies every member of staff needs to know."), true);
  assert.equal(introFitsCover("x".repeat(481)), false);
  assert.equal(introFitsCover("Welcome.\n\n## How to use it\n\nRead it."), false);
  assert.equal(introFitsCover("Welcome.\n\n- one\n- two"), false);
});

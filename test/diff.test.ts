// The change-size heuristic behind the re-confirmation question (1.10.0,
// lib/diff changeSummary / suggestReconfirm / describeChange). The editor and
// every server write path run these on a confirmed document's edit, so the
// default they pick and the sentence they show must be predictable: a typo
// is editorial, a changed number or heading is material, a few percent of
// prose is borderline, and anything too big to measure is material.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/diff.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_MAX_BLOCKS,
  KEEP_MAX_PCT,
  RESET_MIN_BLOCKS,
  RESET_MIN_PCT,
  changeSummary,
  describeChange,
  diffLines,
  diffStats,
  suggestReconfirm,
} from "../src/lib/diff";

const POLICY = `# Expense policy

All staff must follow this policy when claiming expenses. Claims are checked by the finance team before they are paid, and the team may ask for more detail about any item.

## Section 1

Submit claims within 30 days of the spend. Late claims may be refused unless your manager agrees to them in writing before you submit.

## Section 4

Receipts are required for any claim over £50. Mileage is paid at the standard rate and must be recorded on the [claims form](https://intranet.example/forms/42) with the date and the reason for the journey.

## Section 5

- Keep original receipts for 12 months.
- Do not claim for alcohol.
- Ask before booking travel abroad.

Questions go to the finance team. We aim to answer within two working days and will tell you if anything is missing from your claim.
`;

// Words are tokens with a letter or digit: the "#" heading and "-" bullet markers are not words.
const WORDS = (POLICY.match(/\S+/g) ?? []).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

function edited(from: string, to: string): string {
  assert.ok(POLICY.includes(from), `fixture contains ${JSON.stringify(from)}`);
  return POLICY.replace(from, to);
}

test("thresholds are the agreed values", () => {
  assert.equal(KEEP_MAX_PCT, 2);
  assert.equal(RESET_MIN_PCT, 5);
  assert.equal(KEEP_MAX_BLOCKS, 2);
  assert.equal(RESET_MIN_BLOCKS, 3);
});

test("a typo fix is editorial with high confidence", () => {
  const next = edited("when claiming expenses", "when claming expenses");
  const s = changeSummary(POLICY, next);
  assert.equal(s.wordsOld, WORDS);
  assert.equal(s.wordsNew, WORDS);
  assert.equal(s.wordsChanged, 1);
  assert.equal(s.blocksChanged, 1);
  assert.equal(s.linesAdded, 1);
  assert.equal(s.linesRemoved, 1);
  assert.equal(s.headingsChanged, 0);
  assert.equal(s.listItemsChanged, 0);
  assert.equal(s.numbersChanged, 0);
  assert.equal(s.titleChanged, false);
  assert.equal(s.firstChangedHeading, "Expense policy", "the H1 above the first paragraph");
  assert.equal(s.degraded, false);
  assert.equal(WORDS, 136);
  assert.equal(s.pct, 0.7);
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "high", reason: "1 word in one paragraph (0.7%)" });
  assert.equal(describeChange(s, "v12"), "Looks editorial: 1 word in one paragraph changed (0.7% since v12).");
  assert.equal(describeChange(s), "Looks editorial: 1 word in one paragraph changed (0.7%).");
});

test("a few words in one paragraph stay editorial and name the paragraph count", () => {
  const next = edited("may ask for more detail about any item", "can ask for further detail on any item");
  const s = changeSummary(POLICY, next);
  assert.equal(s.wordsChanged, 3);
  assert.equal(s.blocksChanged, 1);
  assert.equal(s.pct, 2.2);
  assert.equal(suggestReconfirm(s).policy, "keep");
});

test("a single number change is material, located under its heading", () => {
  const next = edited("any claim over £50", "any claim over £75");
  const s = changeSummary(POLICY, next);
  assert.equal(s.wordsChanged, 1);
  assert.equal(s.numbersChanged, 1);
  assert.equal(s.headingsChanged, 0);
  assert.equal(s.firstChangedHeading, "Section 4");
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "high", reason: "a number changed" });
  assert.equal(describeChange(s, "v12"), 'Looks material: a number changed in "Section 4".');
});

test("a changed percentage or decimal counts as a number", () => {
  const next = edited("paid at the standard rate", "paid at 45p per mile, 7.5% above the standard rate");
  const s = changeSummary(POLICY, next);
  assert.equal(s.numbersChanged, 2);
  assert.equal(suggestReconfirm(s).policy, "reset");
  assert.equal(describeChange(s, "v12"), 'Looks material: 2 numbers changed in "Section 4".');
});

test("a heading rename is material and the sentence names the new heading", () => {
  const next = edited("## Section 4", "## Section 4: Travel");
  const s = changeSummary(POLICY, next);
  assert.equal(s.headingsChanged, 1);
  assert.equal(s.numbersChanged, 0, "the 4 is in both headings");
  assert.equal(s.firstChangedHeading, "Section 4: Travel");
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "high", reason: "a heading changed" });
  assert.equal(describeChange(s, "v12"), 'Looks material: a heading changed ("Section 4: Travel").');
});

test("a 3% prose rewrite is borderline: keep with low confidence", () => {
  const next = edited(
    "We aim to answer within two working days and will tell you if anything is missing from your claim.",
    "We try to reply within two working days and will let you know if anything is missing from your claim."
  );
  const s = changeSummary(POLICY, next);
  assert.equal(s.wordsChanged, 4);
  assert.equal(s.blocksChanged, 1);
  assert.equal(s.pct, 2.9);
  assert.equal(s.numbersChanged, 0);
  assert.equal(s.headingsChanged, 0);
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "low", reason: "2.9% changed across one paragraph" });
  assert.equal(
    describeChange(s, "v12"),
    "Borderline: 2.9% changed in one paragraph since v12. Choose Material change if an obligation changed."
  );
  assert.equal(describeChange(s), "Borderline: 2.9% changed in one paragraph. Choose Material change if an obligation changed.");
});

test("a title change alone is material, even with identical text", () => {
  const s = changeSummary(POLICY, POLICY, { oldTitle: "Expense policy", newTitle: "Expenses policy" });
  assert.equal(s.titleChanged, true);
  assert.equal(s.pct, 0);
  assert.equal(s.blocksChanged, 0);
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "high", reason: "the title changed" });
  assert.equal(describeChange(s, "v12"), "Looks material: the title changed.");
  // Whitespace around a title is not a change; missing titles never are.
  assert.equal(changeSummary(POLICY, POLICY, { oldTitle: "Expense policy ", newTitle: "Expense policy" }).titleChanged, false);
  assert.equal(changeSummary(POLICY, POLICY, { oldTitle: "Expense policy" }).titleChanged, false);
  assert.equal(changeSummary(POLICY, POLICY).titleChanged, false);
});

test("the title combines with text signals in one sentence", () => {
  const next = edited("any claim over £50", "any claim over £75");
  const s = changeSummary(POLICY, next, { oldTitle: "Expense policy", newTitle: "Expenses policy" });
  assert.equal(suggestReconfirm(s).reason, "the title and a number changed");
  assert.equal(describeChange(s, "v12"), 'Looks material: the title and a number changed in "Section 4".');
});

test("a CRLF-only difference is no change at all", () => {
  const crlf = POLICY.replace(/\n/g, "\r\n");
  const s = changeSummary(POLICY, crlf);
  assert.equal(s.pct, 0);
  assert.equal(s.wordsChanged, 0);
  assert.equal(s.blocksChanged, 0);
  assert.equal(s.linesAdded, 0);
  assert.equal(s.linesRemoved, 0);
  assert.equal(s.degraded, false);
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "high", reason: "no change to the text" });
  assert.equal(describeChange(s, "v12"), "No change to the text.");
  assert.deepEqual(changeSummary(crlf, POLICY), s);
});

test("re-wrapping a paragraph changes lines but no words", () => {
  const next = edited(
    "Claims are checked by the finance team before they are paid, and the team",
    "Claims are checked by the finance team\nbefore they are paid, and the team"
  );
  const s = changeSummary(POLICY, next);
  assert.equal(s.wordsChanged, 0);
  assert.equal(s.blocksChanged, 0);
  assert.equal(s.pct, 0);
  assert.equal(s.linesAdded, 2);
  assert.equal(s.linesRemoved, 1);
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "high", reason: "only spacing or line breaks changed" });
  assert.equal(describeChange(s, "v12"), "Looks editorial: only spacing or line breaks changed.");
});

test("line counts agree with the compare view's diffStats", () => {
  const next = edited("- Do not claim for alcohol.\n", "- Do not claim for alcohol.\n- Claims must be in sterling.\n");
  const s = changeSummary(POLICY, next);
  const stats = diffStats(diffLines(POLICY, next));
  assert.equal(s.linesAdded, stats.added);
  assert.equal(s.linesRemoved, stats.removed);
});

test("an added list item is borderline, not silently editorial", () => {
  const next = edited("- Do not claim for alcohol.\n", "- Do not claim for alcohol.\n- Claims must be in sterling.\n");
  const s = changeSummary(POLICY, next);
  assert.equal(s.listItemsChanged, 1);
  assert.equal(s.numbersChanged, 0);
  assert.equal(s.wordsChanged, 5);
  assert.equal(s.firstChangedHeading, "Section 5");
  assert.equal(s.pct, 3.5, "5 of the 141 words in the new text");
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "low", reason: "a list item changed (3.5%)" });
  assert.equal(
    describeChange(s, "v12"),
    'Borderline: a list item changed in "Section 5" (3.5% since v12). Choose Material change if an obligation changed.'
  );
  // Rewording an item is also borderline: an obligation may have moved.
  const reworded = changeSummary(POLICY, edited("- Do not claim for alcohol.", "- Never claim for alcohol."));
  assert.equal(reworded.listItemsChanged, 1);
  assert.equal(suggestReconfirm(reworded).confidence, "low");
});

test("renumbering an ordered list is not a number change", () => {
  const ordered = POLICY.replace("- Keep original", "1. Keep original")
    .replace("- Do not claim", "2. Do not claim")
    .replace("- Ask before", "3. Ask before");
  const next = ordered.replace("2. Do not claim", "2. Claims must be in sterling.\n3. Do not claim").replace("3. Ask before", "4. Ask before");
  const s = changeSummary(ordered, next);
  assert.equal(s.numbersChanged, 0);
  assert.equal(s.listItemsChanged, 1);
  assert.equal(suggestReconfirm(s).policy, "keep");
});

test("fixing a link target is editorial: digits in URLs are not numbers", () => {
  const next = edited("intranet.example/forms/42", "intranet.example/forms/43");
  const s = changeSummary(POLICY, next);
  assert.equal(s.numbersChanged, 0);
  assert.equal(s.wordsChanged, 1);
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "high", reason: "1 word in one paragraph (0.7%)" });
  assert.equal(describeChange(s, "v12"), "Looks editorial: 1 word in one paragraph changed (0.7% since v12).");
});

test("a large rewrite is material by share of words", () => {
  const next = edited(
    "Submit claims within 30 days of the spend. Late claims may be refused unless your manager agrees to them in writing before you submit.",
    "Submit claims within 30 days of the spend. Claims received after that are refused automatically, and only a director can approve an exception, which must be requested in writing with the reason for the delay."
  ).replace(
    "Questions go to the finance team. We aim to answer within two working days and will tell you if anything is missing from your claim.",
    "Questions go to the finance team, who reply within two working days. Incomplete claims are returned with a note explaining what is missing and how to resubmit them."
  );
  const s = changeSummary(POLICY, next);
  assert.equal(s.numbersChanged, 0);
  assert.equal(s.headingsChanged, 0);
  assert.equal(s.blocksChanged, 2);
  assert.ok(s.pct >= RESET_MIN_PCT, `pct ${s.pct}`);
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "high", reason: `${s.pct}% of the words changed` });
  assert.equal(describeChange(s, "v12"), `Looks material: ${s.wordsChanged} words across 2 paragraphs changed (${s.pct}% since v12).`);
});

test("small edits spread over three paragraphs are material with low confidence", () => {
  const next = edited("may ask for more detail", "may ask for further detail")
    .replace("Late claims may be refused", "Late claims can be refused")
    .replace("will tell you if anything", "will say if anything");
  const s = changeSummary(POLICY, next);
  assert.equal(s.blocksChanged, 3);
  assert.ok(s.pct < RESET_MIN_PCT, `pct ${s.pct}`);
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "low", reason: "3 paragraphs changed" });
  assert.equal(describeChange(s, "v12"), `Looks material: ${s.wordsChanged} words across 3 paragraphs changed (${s.pct}% since v12).`);
});

test("splitting a paragraph changes no words and reads as rearranged", () => {
  const next = edited(
    "any claim over £50. Mileage is paid",
    "any claim over £50.\n\nMileage is paid"
  );
  const s = changeSummary(POLICY, next);
  assert.equal(s.numbersChanged, 0, "the £50 is still there");
  assert.equal(s.wordsChanged, 0);
  assert.equal(s.blocksChanged, 2);
  assert.equal(s.firstChangedHeading, "Section 4");
  assert.deepEqual(suggestReconfirm(s), { policy: "keep", confidence: "high", reason: "2 paragraphs rearranged (0%)" });
  assert.equal(describeChange(s, "v12"), "Looks editorial: 2 paragraphs rearranged, no words changed (0% since v12).");
});

test("rearranging three or more paragraphs is material even with no word change", () => {
  const next = edited("when claiming expenses. Claims are checked", "when claiming expenses.\n\nClaims are checked").replace(
    "any claim over £50. Mileage is paid",
    "any claim over £50.\n\nMileage is paid"
  );
  const s = changeSummary(POLICY, next);
  assert.equal(s.wordsChanged, 0);
  assert.equal(s.blocksChanged, 4);
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "low", reason: "4 paragraphs changed" });
  assert.equal(describeChange(s, "v12"), "Looks material: 4 paragraphs rearranged, no words changed (0% since v12).");
});

test("a long heading is shortened in the sentence and trailing hashes are dropped", () => {
  const heading = "Section 6: travel, subsistence, accommodation and other costs incurred away from the office ##";
  const withLong = `${POLICY}\n## ${heading}\n\nMeals away from the office are capped at £25 a day.\n`;
  const s = changeSummary(withLong, withLong.replace("£25 a day", "£30 a day"));
  assert.equal(s.numbersChanged, 1);
  assert.equal(s.firstChangedHeading, heading.replace(/ ##$/, ""));
  assert.equal(
    describeChange(s),
    'Looks material: a number changed in "Section 6: travel, subsistence, accommodation and other cos…".'
  );
});

test("moving a sentence counts its words once, not on both sides", () => {
  const next = edited(
    "Receipts are required for any claim over £50. Mileage is paid at the standard rate and must be recorded on the [claims form](https://intranet.example/forms/42) with the date and the reason for the journey.",
    "Mileage is paid at the standard rate and must be recorded on the [claims form](https://intranet.example/forms/42) with the date and the reason for the journey.\n\nReceipts are required for any claim over £50."
  );
  const s = changeSummary(POLICY, next);
  assert.equal(s.numbersChanged, 0, "the £50 moved, it did not change");
  assert.equal(s.wordsChanged, 8, "the moved sentence, counted once");
  assert.equal(s.blocksChanged, 2);
  assert.equal(s.firstChangedHeading, "Section 4");
  assert.equal(s.pct, 5.9);
  assert.equal(suggestReconfirm(s).policy, "reset", "a moved obligation is worth asking about");
});

test("headings and list markers inside fenced code are ignored", () => {
  const withCode = `${POLICY}\n\`\`\`\n# not a heading\n- not an item\n\`\`\`\n`;
  const next = withCode.replace("# not a heading", "# still not a heading");
  const s = changeSummary(withCode, next);
  assert.equal(s.headingsChanged, 0);
  assert.equal(s.listItemsChanged, 0);
  assert.equal(s.wordsChanged, 1);
});

test("too many changed lines degrades to a material change", () => {
  const before = Array.from({ length: 3500 }, (_, i) => `line ${i}`).join("\n");
  const after = Array.from({ length: 3500 }, (_, i) => `line ${i} changed`).join("\n");
  const s = changeSummary(before, after);
  assert.equal(s.degraded, true);
  assert.equal(s.pct, 100);
  assert.equal(s.linesAdded, 3500);
  assert.equal(s.linesRemoved, 3500);
  assert.deepEqual(suggestReconfirm(s), { policy: "reset", confidence: "high", reason: "too much changed to measure" });
  assert.equal(describeChange(s, "v12"), "Looks material: too much changed since v12 to measure.");
  assert.equal(describeChange(s), "Looks material: too much changed to measure.");
});

test("a paragraph rewritten past the word-pair guard degrades too", () => {
  const before = Array.from({ length: 300 }, (_, i) => `old${i}`).join(" ");
  const after = Array.from({ length: 300 }, (_, i) => `new${i}`).join(" ");
  const s = changeSummary(`${POLICY}\n${before}\n`, `${POLICY}\n${after}\n`);
  assert.equal(s.degraded, true);
  assert.equal(s.pct, 100);
  assert.equal(suggestReconfirm(s).policy, "reset");
});

test("small fixes in several adjacent paragraphs do not trip the word-pair guard", () => {
  const paragraphs = Array.from({ length: 4 }, (_, p) =>
    Array.from({ length: 120 }, (_, i) => `p${p}w${i}`).join(" ")
  );
  const before = paragraphs.join("\n\n");
  const after = paragraphs.map((t, p) => t.replace(`p${p}w60`, `p${p}fixed`)).join("\n\n");
  const s = changeSummary(before, after);
  assert.equal(s.degraded, false);
  assert.equal(s.wordsChanged, 4);
  assert.equal(s.blocksChanged, 4);
  assert.equal(s.pct, 0.8);
});

test("whole-document replacement and empty inputs are sane", () => {
  const all = changeSummary(POLICY, "Something else entirely.");
  assert.equal(all.pct, 100);
  assert.equal(all.degraded, false);
  assert.equal(suggestReconfirm(all).policy, "reset");
  const fromEmpty = changeSummary("", POLICY);
  assert.equal(fromEmpty.wordsOld, 0);
  assert.equal(fromEmpty.wordsChanged, WORDS);
  assert.equal(fromEmpty.pct, 100);
  const toEmpty = changeSummary(POLICY, "");
  assert.equal(toEmpty.pct, 100);
  assert.equal(toEmpty.wordsNew, 0);
  const both = changeSummary("", "");
  assert.equal(both.pct, 0);
  assert.equal(describeChange(both), "No change to the text.");
});

test("a tiny edit in a long document still shows a non-zero share", () => {
  const long = Array.from({ length: 50 }, () => POLICY).join("\n");
  const s = changeSummary(long, long.replace("claiming expenses", "claming expenses"));
  assert.equal(s.wordsChanged, 1);
  assert.equal(s.pct, 0.1);
  assert.equal(suggestReconfirm(s).policy, "keep");
});

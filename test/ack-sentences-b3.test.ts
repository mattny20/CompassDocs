// The re-confirmation sentences (B3, 1.11.0): the card's reason line
// (AckCard.reasonSentence) and the notice strip's one sentence
// (DocNotices.reconfirmSentence) have omission and fallback rules that the
// e2e exercises for the edit and manual kinds only. Pure, so these pin every
// kind without a database or a browser: the "A manager" fallback when the
// row carries no name, a quoted note against a bare full stop, the annual
// cycle's month count, and the strip's last resort when the marker moved
// with neither a version nor a ledger row.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/ack-sentences-b3.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonSentence } from "../src/components/AckCard";
import { reconfirmSentence } from "../src/components/DocNotices";
import { monthsLabel } from "../src/components/AckState";
import type { AckReason, PriorConfirmation } from "../src/components/AckState";

const date = (iso: string) => (iso.startsWith("2026-03-03") ? "3 Mar 2026" : iso);
const AT = "2026-03-03T09:00:00Z";
const NOTE = "Section 4 now covers contractors";

const prior = (over: Partial<PriorConfirmation>): PriorConfirmation => ({
  ackedAt: AT,
  versionId: 12,
  rev: 12,
  inferred: false,
  changed: false,
  reason: null,
  ...over,
});

test("monthsLabel: one month, twelve months", () => {
  assert.equal(monthsLabel(1), "1 month");
  assert.equal(monthsLabel(12), "12 months");
});

test("the card's reason line for an edit: the day, the author and the quoted note; each omitted when empty", () => {
  const edit: AckReason = { kind: "edit", at: AT, by: "Priya", note: NOTE };
  assert.equal(reasonSentence(edit, date), 'Updated 3 Mar 2026 by Priya: "Section 4 now covers contractors"');
  assert.equal(reasonSentence({ ...edit, note: "" }, date), "Updated 3 Mar 2026 by Priya.");
  assert.equal(reasonSentence({ ...edit, by: "" }, date), 'Updated 3 Mar 2026: "Section 4 now covers contractors"');
  assert.equal(reasonSentence({ ...edit, by: "", note: "" }, date), "Updated 3 Mar 2026.");
});

test("the card's reason line for a manual re-ask names who asked, or 'A manager'", () => {
  const manual: AckReason = { kind: "manual", at: AT, by: "Priya", note: NOTE };
  assert.equal(
    reasonSentence(manual, date),
    'Priya asked everyone to confirm this document again on 3 Mar 2026: "Section 4 now covers contractors"'
  );
  assert.equal(
    reasonSentence({ ...manual, by: "", note: "" }, date),
    "A manager asked everyone to confirm this document again on 3 Mar 2026."
  );
});

test("the card's reason line for a per-person re-ask says 'you', with the same fallback", () => {
  const person: AckReason = { kind: "person", at: AT, by: "Priya", note: NOTE };
  assert.equal(
    reasonSentence(person, date),
    'Priya asked you to confirm this document again on 3 Mar 2026: "Section 4 now covers contractors"'
  );
  assert.equal(
    reasonSentence({ ...person, by: "", note: "" }, date),
    "A manager asked you to confirm this document again on 3 Mar 2026."
  );
});

test("the card's reason line for the annual cycle counts the months and never names a day", () => {
  assert.equal(
    reasonSentence({ kind: "recurrence", months: 12 }, date),
    "Annual re-confirmation. It has been 12 months since you confirmed this document. Please read it again and confirm."
  );
  assert.equal(
    reasonSentence({ kind: "recurrence", months: 1 }, date),
    "Annual re-confirmation. It has been 1 month since you confirmed this document. Please read it again and confirm."
  );
});

test("the strip says the document changed whenever a version was written since, whatever the reason", () => {
  const changed = "This document changed since you confirmed it on 3 Mar 2026. Please read the changes and confirm again.";
  assert.equal(reconfirmSentence(prior({ changed: true }), date), changed);
  assert.equal(
    reconfirmSentence(prior({ changed: true, reason: { kind: "manual", at: AT, by: "Priya", note: NOTE } }), date),
    changed
  );
  assert.equal(reconfirmSentence(prior({ changed: true, reason: { kind: "recurrence", months: 12 } }), date), changed);
});

test("without a text change the strip takes the shape of the re-ask", () => {
  assert.equal(
    reconfirmSentence(prior({ reason: { kind: "recurrence", months: 12 } }), date),
    "It has been 12 months since you confirmed this document. Please read it again and confirm."
  );
  assert.equal(
    reconfirmSentence(prior({ reason: { kind: "manual", at: AT, by: "Priya", note: NOTE } }), date),
    "Everyone was asked to confirm this document again on 3 Mar 2026. Please read it and confirm again."
  );
  assert.equal(
    reconfirmSentence(prior({ reason: { kind: "person", at: AT, by: "Priya", note: NOTE } }), date),
    "Priya asked you to confirm this document again on 3 Mar 2026. Please read it and confirm again."
  );
  // The strip never opens with a bare "asked you": a row with no name falls back the way the card does.
  assert.equal(
    reconfirmSentence(prior({ reason: { kind: "person", at: AT, by: "", note: "" } }), date),
    "A manager asked you to confirm this document again on 3 Mar 2026. Please read it and confirm again."
  );
});

test("the strip's last resort: a marker that moved with no version and no ledger row", () => {
  const lastResort = "You were asked to confirm this document again. Please read it and confirm again.";
  assert.equal(reconfirmSentence(prior({ reason: null }), date), lastResort);
  // An 'edit' reason without a text change cannot normally happen; it reads the same way rather than claiming a change.
  assert.equal(reconfirmSentence(prior({ reason: { kind: "edit", at: AT, by: "Priya", note: NOTE } }), date), lastResort);
});

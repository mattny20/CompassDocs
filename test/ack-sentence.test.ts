// The Read confirmation subtitle (C1, 1.10.0) has omission rules that are
// easy to get backwards: no reason means no quote, an edit by the version's
// own author means no "by", and no ledger row yet means the marker date
// alone. Pure, so these pin the sentence without a database.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/ack-sentence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmationSentence } from "../src/app/(app)/doc/[id]/acknowledgements/ack-sentence";

const formatDate = (iso: string) => (iso.startsWith("2026-03-03") ? "3 Mar 2026" : iso);
const base = {
  current: 42,
  eligible: 50,
  rev: 12,
  author: "Matt",
  resetAt: "2026-01-01T00:00:00Z",
  formatDate,
};
const asked = {
  decided_at: "2026-03-03T09:00:00Z",
  decided_by_name: "Matt",
  source: "manual",
  reason: "Section 4 now covers contractors",
};

test("the full sentence: count, version, date, name and the quoted reason", () => {
  assert.equal(
    confirmationSentence({ ...base, asked }),
    '42 of 50 people have confirmed version 12 · asked 3 Mar 2026 by Matt: "Section 4 now covers contractors"'
  );
});

test("an empty reason drops the quote", () => {
  assert.equal(
    confirmationSentence({ ...base, asked: { ...asked, reason: "  " } }),
    "42 of 50 people have confirmed version 12 · asked 3 Mar 2026 by Matt"
  );
});

test("an edit by the version's own author drops 'by'; anyone else keeps it", () => {
  assert.equal(
    confirmationSentence({ ...base, asked: { ...asked, source: "edit", decided_by_name: "matt " } }),
    '42 of 50 people have confirmed version 12 · asked 3 Mar 2026: "Section 4 now covers contractors"'
  );
  assert.equal(
    confirmationSentence({ ...base, asked: { ...asked, source: "edit", decided_by_name: "Priya" } }),
    '42 of 50 people have confirmed version 12 · asked 3 Mar 2026 by Priya: "Section 4 now covers contractors"'
  );
  // The rule is about edits: a manual ask by the author still names them.
  assert.match(confirmationSentence({ ...base, asked }), / by Matt: /);
});

test("before the ledger has a row, the marker date stands in", () => {
  assert.equal(
    confirmationSentence({ ...base, asked: null }),
    "42 of 50 people have confirmed version 12 · asked 2026-01-01T00:00:00Z"
  );
});

test("one person, and a document with no version yet", () => {
  assert.equal(
    confirmationSentence({ ...base, current: 1, eligible: 1, asked: null }),
    "1 of 1 person has confirmed version 12 · asked 2026-01-01T00:00:00Z"
  );
  assert.equal(
    confirmationSentence({ ...base, rev: null, asked: null }),
    "42 of 50 people have confirmed the current version · asked 2026-01-01T00:00:00Z"
  );
});

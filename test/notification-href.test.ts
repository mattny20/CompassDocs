// Where a notification opens (H1, 1.10.1): a read-confirmation notice lands
// on the confirmation card at the end of the document. The outbox writes
// "/doc/{id}#confirm-reading"; a row written before 1.10.1 carries the bare
// document link and gains the hash here; a link that already has one, every
// other kind, a non-document link and an empty link open exactly what they
// stored. Pure: no database, no DOM.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/notification-href.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationHref } from "../src/components/NotificationRow";
import { CONFIRM_SECTION_ID } from "../src/lib/use-reached-end";

test("an ack notice with the bare document link lands on the confirmation card", () => {
  assert.equal(CONFIRM_SECTION_ID, "confirm-reading");
  assert.equal(notificationHref({ kind: "ack_requested", link: "/doc/12" }), "/doc/12#confirm-reading");
});

test("a link that already carries a hash is left alone", () => {
  assert.equal(notificationHref({ kind: "ack_requested", link: "/doc/12#confirm-reading" }), "/doc/12#confirm-reading");
  assert.equal(notificationHref({ kind: "ack_requested", link: "/doc/12#section-4" }), "/doc/12#section-4");
});

test("every other kind opens exactly what it stored", () => {
  assert.equal(notificationHref({ kind: "doc_update", link: "/doc/12" }), "/doc/12");
  assert.equal(notificationHref({ kind: "mention", link: "/doc/12" }), "/doc/12");
  assert.equal(notificationHref({ kind: "review_due", link: "/doc/12" }), "/doc/12");
});

test("a non-document link and an empty link are unchanged", () => {
  assert.equal(notificationHref({ kind: "ack_requested", link: "/review" }), "/review");
  assert.equal(notificationHref({ kind: "ack_requested", link: "" }), "");
});

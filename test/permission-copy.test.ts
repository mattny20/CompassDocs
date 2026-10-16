// The permission catalog is read by people: Settings → Roles renders every
// label and description. The read-confirmation glossary (STYLEGUIDE
// §Vocabulary, 1.10.0) keeps "acknowledgement" only in KEYS and bans the
// verbs "acknowledge" / "attest" everywhere a person reads, so the copy of
// the ack and compliance permissions is pinned here. Pure: no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, permission } from "../src/lib/permissions";

// "attestation record" is the glossary's noun for the evidence row and is
// allowed; the verb forms and "acknowledg…" are not.
const BANNED = /\b(acknowledg\w*|attests?|attested|attesting)\b/i;

test("no permission label or description says acknowledge or attest (keys keep ack)", () => {
  const hits = PERMISSIONS.filter((p) => BANNED.test(p.label) || BANNED.test(p.description)).map(
    (p) => `${p.key}: "${p.label}" / "${p.description}"`
  );
  assert.deepEqual(hits, [], `glossary drift in the permission catalog:\n${hits.join("\n")}`);
});

test("the read-confirmation permissions carry the glossary wording and their keys are unchanged", () => {
  assert.equal(permission("document.ack_require").label, "Require read confirmation");
  assert.equal(permission("document.ack_roster_read").label, "Read the confirmation record");
  assert.equal(permission("document.ack_submit").label, "Submit read confirmation");
  assert.equal(permission("document.ack_submit").description, "Record that you have read and understood a policy");
  assert.equal(permission("compliance.export").label, "Export compliance records");
  for (const key of ["document.ack_require", "document.ack_roster_read", "document.ack_submit"] as const) {
    assert.equal(permission(key).scope, "space");
  }
});

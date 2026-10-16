// What the reader last confirmed (1.11.0, B3). getCurrentAck answers "does a
// confirmation count against the marker"; getLatestAck answers "what did
// this person last confirm", current or lapsed, so the document page can
// say "This document changed since you confirmed it on 3 Mar" and diff the
// live text against that version. A row from before version binding gets
// the newest version that existed when the person confirmed, flagged
// inferred, so a legacy record still anchors the comparison.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  createDocument,
  updateDocument,
  setAckRequired,
  recordAcknowledgement,
  getCurrentAck,
  getLatestAck,
  listVersions,
} from "../src/lib/db";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackreader-${Date.now()}`;

let spaceId = 0;
let readerId = 0;
let editorId = 0;
const docIds: number[] = [];

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newPolicy(title: string): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content: LONG_TEXT,
    summary: "",
    tags: [],
    author: "test",
  });
  await setAckRequired(doc.id, true, { editDefault: null });
  docIds.push(doc.id);
  return { id: doc.id, v1: (await listVersions(doc.id))[0].id };
}

/** A material change through the editor's API path: the marker moves and every confirmation lapses. */
async function reset(id: number, suffix: string) {
  await updateDocument(id, {
    content: `${LONG_TEXT}\n\n${suffix}`,
    ackPolicy: "reset",
    ackReason: "Cap raised; everyone must read the new figure",
    ackActor: { id: editorId, name: "Reader Editor" },
    ackSource: "edit",
  });
  return (await listVersions(id))[0].id;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Reader ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Reader Reader', $2, 'viewer', 'active'),
       ($3, 'Reader Editor', $4, 'editor', 'active')
     RETURNING id`,
    [`${STAMP}-reader`, `${STAMP}-reader@example.test`, `${STAMP}-editor`, `${STAMP}-editor@example.test`]
  );
  readerId = users.rows[0].id;
  editorId = users.rows[1].id;
});

after(async () => {
  const userIds = [readerId, editorId];
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [
    docIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("getLatestAck: what the reader last confirmed", () => {
  test("nobody has confirmed: nothing, like getCurrentAck", async () => {
    const { id } = await newPolicy(`${STAMP} none`);
    assert.equal(await getCurrentAck(id, readerId), undefined);
    assert.equal(await getLatestAck(id, readerId), undefined);
  });

  test("a current confirmation is the row getCurrentAck returns, flagged current", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} current`);
    await recordAcknowledgement(id, readerId, "", v1);
    const current = await getCurrentAck(id, readerId);
    const latest = await getLatestAck(id, readerId);
    assert.ok(current && latest);
    assert.equal(latest.current, true);
    assert.equal(latest.version_inferred, false);
    assert.equal(latest.version_id, v1);
    assert.equal(latest.rev, 1);
    assert.equal(latest.acknowledged_at, current.acknowledged_at);
    assert.equal(latest.content_sha256, current.content_sha256);
  });

  test("after a reset the confirmation lapses: getCurrentAck is empty, getLatestAck keeps the row with its version", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} lapsed`);
    await recordAcknowledgement(id, readerId, "", v1);
    const v2 = await reset(id, "The cap is now 75.");
    assert.equal(await getCurrentAck(id, readerId), undefined, "the reset made the confirmation stale");
    const latest = await getLatestAck(id, readerId);
    assert.ok(latest, "the lapsed row is still what they last confirmed");
    assert.equal(latest.current, false);
    assert.equal(latest.version_id, v1, "it cites the version they read, not the new one");
    assert.equal(latest.rev, 1);
    assert.equal(latest.version_inferred, false);
    assert.ok(latest.content_sha256, "a recorded row keeps its hash");
    // The versions since the confirmed one: exactly the reset's version.
    const since = (await listVersions(id)).filter((v) => v.id > latest.version_id!);
    assert.deepEqual(
      since.map((v) => v.id),
      [v2]
    );
  });

  test("the newest row wins: re-confirming the new text is current again and cites it", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} again`);
    await recordAcknowledgement(id, readerId, "", v1);
    const v2 = await reset(id, "Section 4 now covers contractors.");
    await recordAcknowledgement(id, readerId, "", v2);
    const latest = await getLatestAck(id, readerId);
    assert.ok(latest);
    assert.equal(latest.current, true);
    assert.equal(latest.version_id, v2);
    assert.equal(latest.rev, 2);
    assert.equal((await getCurrentAck(id, readerId))?.version_id, v2);
  });

  test("a row without a version (before 1.10.0) is inferred from the newest version at its time", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} legacy`);
    // A 1.9.x-shaped row: no version, no hash, stamped now (after v1 was
    // written). The reset that follows writes v2 later, so the inference
    // must pick v1, the newest version that existed when they confirmed.
    await fixtureQuery(
      `INSERT INTO acknowledgements
         (document_id, user_id, ip, version_id, content_sha256, user_name, user_email, document_title, acknowledged_at)
       VALUES ($1, $2, '', NULL, NULL, 'Reader Reader', $3, $4, clock_timestamp())`,
      [id, readerId, `${STAMP}-reader@example.test`, `${STAMP} legacy`]
    );
    const beforeReset = await getLatestAck(id, readerId);
    assert.ok(beforeReset);
    assert.equal(beforeReset.current, true, "stamped after the marker, so it counts");
    assert.equal(beforeReset.version_inferred, true);
    assert.equal(beforeReset.version_id, v1);
    assert.equal(beforeReset.rev, 1);
    assert.equal(beforeReset.content_sha256, null);

    await reset(id, "Receipts are required over 20.");
    assert.equal(await getCurrentAck(id, readerId), undefined);
    const lapsed = await getLatestAck(id, readerId);
    assert.ok(lapsed);
    assert.equal(lapsed.current, false);
    assert.equal(lapsed.version_inferred, true, "still inferred: the row never recorded a version");
    assert.equal(lapsed.version_id, v1, "the inference ignores the version written after they confirmed");
    assert.equal(lapsed.rev, 1);
  });

  test("another person's confirmation is never returned", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} other`);
    await recordAcknowledgement(id, editorId, "", v1);
    assert.equal(await getLatestAck(id, readerId), undefined);
    assert.equal((await getLatestAck(id, editorId))?.version_id, v1);
  });
});

// Reading evidence on the attestation record (1.11.0, C3): the read time a
// confirmation stores is summed on the server from this person's view
// heartbeats for the document since everyone was last asked (the last 30
// days when there is no marker), the reached-the-end flag is the card's own
// report and is stored only when the body says the JSON boolean true, both
// land on the row and come back on the roster and former-staff readers, the
// CSV appends them after the provenance pair, and the Record page's warn
// tone follows one pure rule.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pool,
  getSetting,
  createDocument,
  setAckRequired,
  recordAcknowledgement,
  ackStatusForDocument,
  ackFormerStaffRows,
  listVersions,
} from "../src/lib/db";
import { readSecondsSince } from "../src/lib/analytics";
import {
  WORDS_PER_MINUTE,
  SHORT_READ_SHARE,
  ROSTER_CSV_HEADER,
  documentWordCount,
  typicalReadSeconds,
  isShortRead,
  readTimeLabel,
  reachedEndFromBody,
  storedReadSeconds,
  evidenceCsvCells,
} from "../src/lib/read-evidence";
import { fixtureQuery } from "./support/retry";

const STAMP = `ackevi-${Date.now()}`;

let spaceId = 0;
let readerId = 0;
let otherId = 0;
const docIds: number[] = [];

const TEXT = Array.from({ length: 50 }, (_, i) => `Clause ${i + 1}: staff must follow the procedure described here.`).join(
  "\n\n"
);

async function newPolicy(title: string, content = TEXT): Promise<{ id: number; v1: number }> {
  const doc = await createDocument({
    space_id: spaceId,
    title,
    type: "policy",
    status: "published",
    content,
    summary: "",
    tags: [],
    author: "test",
  });
  await setAckRequired(doc.id, true);
  docIds.push(doc.id);
  return { id: doc.id, v1: (await listVersions(doc.id))[0].id };
}

/** Move the marker to a known instant so views can be placed on either side of it. */
async function setMarker(docId: number, interval: string): Promise<string> {
  const r = await pool().query<{ at: string }>(
    `UPDATE documents SET ack_revision_at = now() - $2::interval WHERE id = $1 RETURNING ack_revision_at AS at`,
    [docId, interval]
  );
  return r.rows[0].at;
}

/** One view row: the heartbeat's final duration, placed `ago` before now. */
async function view(docId: number, userId: number, seconds: number, ago: string): Promise<void> {
  await fixtureQuery(
    `INSERT INTO doc_views (document_id, user_id, source, duration_seconds, viewed_at)
     VALUES ($1, $2, 'app', $3, now() - $4::interval)`,
    [docId, userId, seconds, ago]
  );
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  const sp = await fixtureQuery(
    `INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ($1, $2, '📁', '', 'internal') RETURNING id`,
    [`Ack Evidence ${STAMP}`, STAMP]
  );
  spaceId = sp.rows[0].id;
  const users = await fixtureQuery(
    `INSERT INTO users (username, name, email, role, status) VALUES
       ($1, 'Evi Reader', $2, 'viewer', 'active'),
       ($3, 'Evi Other', $4, 'viewer', 'active')
     RETURNING id`,
    [`${STAMP}-reader`, `${STAMP}-reader@example.test`, `${STAMP}-other`, `${STAMP}-other@example.test`]
  );
  readerId = users.rows[0].id;
  otherId = users.rows[1].id;
});

after(async () => {
  const userIds = [readerId, otherId];
  await pool().query("DELETE FROM doc_views WHERE document_id = ANY($1) OR user_id = ANY($2)", [docIds, userIds]);
  await pool().query("DELETE FROM acknowledgements WHERE document_id = ANY($1) OR user_id = ANY($2) OR document_title LIKE $3", [
    docIds,
    userIds,
    `${STAMP}%`,
  ]);
  await pool().query("DELETE FROM ack_decisions WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM attested_texts WHERE document_id = ANY($1) OR document_title LIKE $2", [docIds, `${STAMP}%`]);
  await pool().query("DELETE FROM ack_outbox WHERE document_id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM documents WHERE id = ANY($1)", [docIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM spaces WHERE id = $1", [spaceId]);
});

describe("the read time is summed on the server", () => {
  test("readSecondsSince sums this person's views of this document since the marker and nothing else", async () => {
    const { id } = await newPolicy(`${STAMP} since marker`);
    const marker = await setMarker(id, "1 hour");
    const { id: other } = await newPolicy(`${STAMP} other document`);

    await view(id, readerId, 100, "2 hours"); // before the marker: the text everyone was asked to read did not exist yet
    await view(id, readerId, 30, "30 minutes");
    await view(id, readerId, 45, "5 minutes");
    await view(id, otherId, 500, "5 minutes"); // someone else
    await view(other, readerId, 700, "5 minutes"); // another document

    assert.equal(await readSecondsSince(id, readerId, marker), 75, "the two views since the marker, summed");
    assert.equal(await readSecondsSince(id, otherId, marker), 500);
    assert.equal(await readSecondsSince(other, readerId, marker), 700);
  });

  test("with no marker the last 30 days count; with no view at all the answer is null, not zero", async () => {
    const { id } = await newPolicy(`${STAMP} fallback`);
    await view(id, readerId, 200, "40 days"); // outside the window
    await view(id, readerId, 20, "20 days");
    await view(id, readerId, 15, "1 minute");

    assert.equal(await readSecondsSince(id, readerId, null), 35, "the 30-day window");
    assert.equal(await readSecondsSince(id, otherId, null), null, "no view recorded: unknown, not zero");
    assert.equal(await readSecondsSince(id, otherId, await setMarker(id, "1 day")), null);
  });

  test("the doc_views index the sum relies on exists", async () => {
    const r = await pool().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_views_doc_user'"
    );
    assert.equal(r.rows.length, 1, "idx_views_doc_user exists");
    assert.match(r.rows[0].indexdef, /ON (public\.)?doc_views USING btree \(document_id, user_id, viewed_at DESC\)/);
  });
});

describe("the record stores both and the readers return them", () => {
  test("recordAcknowledgement writes read_seconds and reached_end; the roster and the former-staff list carry them", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} stored`);
    assert.deepEqual(await recordAcknowledgement(id, readerId, "", v1, { readSeconds: 75, reachedEnd: true }), {
      recorded: true,
      stale: false,
    });
    const row = await pool().query<{ read_seconds: number | null; reached_end: number }>(
      "SELECT read_seconds, reached_end FROM acknowledgements WHERE document_id = $1 AND user_id = $2",
      [id, readerId]
    );
    assert.deepEqual(row.rows, [{ read_seconds: 75, reached_end: 1 }]);

    const roster = await ackStatusForDocument(id);
    const mine = roster.find((r) => r.id === readerId)!;
    assert.equal(mine.read_seconds, 75);
    assert.equal(mine.reached_end, true);
    const pending = roster.find((r) => r.id === otherId)!;
    assert.equal(pending.acknowledged_at, null);
    assert.equal(pending.read_seconds, null, "a pending row has no read time");
    assert.equal(pending.reached_end, null, "and no report");

    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [readerId]);
    try {
      const former = await ackFormerStaffRows(id);
      assert.equal(former.length, 1);
      assert.equal(former[0].read_seconds, 75);
      assert.equal(former[0].reached_end, true);
    } finally {
      await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [readerId]);
    }
  });

  test("a confirmation without evidence stores an unknown read time and no report; the seconds are stored whole and never negative", async () => {
    const { id, v1 } = await newPolicy(`${STAMP} without`);
    await recordAcknowledgement(id, readerId, "", v1);
    const { id: second, v1: secondV1 } = await newPolicy(`${STAMP} clamped`);
    await recordAcknowledgement(second, readerId, "", secondV1, { readSeconds: 12.9, reachedEnd: false });
    const { id: third, v1: thirdV1 } = await newPolicy(`${STAMP} negative`);
    await recordAcknowledgement(third, readerId, "", thirdV1, { readSeconds: -5, reachedEnd: true });

    const rows = await pool().query<{ document_id: number; read_seconds: number | null; reached_end: number }>(
      "SELECT document_id, read_seconds, reached_end FROM acknowledgements WHERE document_id = ANY($1) AND user_id = $2 ORDER BY document_id",
      [[id, second, third], readerId]
    );
    assert.deepEqual(rows.rows, [
      { document_id: id, read_seconds: null, reached_end: 0 },
      { document_id: second, read_seconds: 12, reached_end: 0 },
      { document_id: third, read_seconds: 0, reached_end: 1 },
    ]);
    const mine = (await ackStatusForDocument(id)).find((r) => r.id === readerId)!;
    assert.equal(mine.read_seconds, null);
    assert.equal(mine.reached_end, false, "confirmed, but the card did not report the end");
  });
});

describe("the pure rules", () => {
  test("reached_end is read from the body only as the JSON boolean true", () => {
    assert.equal(reachedEndFromBody({ version_id: 1, reached_end: true }), true);
    assert.equal(reachedEndFromBody({ version_id: 1, reached_end: false }), false);
    assert.equal(reachedEndFromBody({ version_id: 1 }), false, "a missing field is false");
    assert.equal(reachedEndFromBody({ reached_end: "true" }), false, "a string is not a report");
    assert.equal(reachedEndFromBody({ reached_end: 1 }), false);
    assert.equal(reachedEndFromBody({ reached_end: "yes" }), false);
    assert.equal(reachedEndFromBody({ reached_end: null }), false);
    assert.equal(reachedEndFromBody(null), false);
    assert.equal(reachedEndFromBody(undefined), false);
    assert.equal(reachedEndFromBody("reached_end"), false);
  });

  test("the stored seconds are whole, non-negative, or null when unknown", () => {
    assert.equal(storedReadSeconds(null), null);
    assert.equal(storedReadSeconds(undefined), null);
    assert.equal(storedReadSeconds(Number.NaN), null);
    assert.equal(storedReadSeconds(0), 0);
    assert.equal(storedReadSeconds(12.9), 12);
    assert.equal(storedReadSeconds(-5), 0);
  });

  test("the threshold rule: warn only below a quarter of a typical read at 200 words per minute, never on an unknown time", () => {
    assert.equal(WORDS_PER_MINUTE, 200);
    assert.equal(SHORT_READ_SHARE, 0.25);
    assert.equal(typicalReadSeconds(1000), 300, "a thousand words is a five-minute read");
    assert.equal(isShortRead(74, 1000), true, "under 75 seconds of a 300-second read");
    assert.equal(isShortRead(75, 1000), false, "the quarter itself is not short");
    assert.equal(isShortRead(300, 1000), false);
    assert.equal(isShortRead(0, 1000), true);
    assert.equal(isShortRead(null, 1000), false, "an unknown read time is never flagged");
    assert.equal(isShortRead(undefined, 1000), false);
    assert.equal(isShortRead(0, 0), false, "nothing to read, nothing to flag");
    assert.equal(isShortRead(5, 10), false, "ten words: a 3-second read, 5 seconds is plenty");
  });

  test("the Read time label", () => {
    assert.equal(readTimeLabel(null), "");
    assert.equal(readTimeLabel(undefined), "");
    assert.equal(readTimeLabel(0), "under 1 min");
    assert.equal(readTimeLabel(59), "under 1 min");
    assert.equal(readTimeLabel(60), "1 min");
    assert.equal(readTimeLabel(360), "6 min");
    assert.equal(readTimeLabel(389), "6 min");
    assert.equal(readTimeLabel(3600), "1 h");
    assert.equal(readTimeLabel(3900), "1 h 5 min");
  });

  test("the word count counts words, not markup", () => {
    assert.equal(documentWordCount("## Policy\n\nShort policy text, read it.\n\n---"), 6);
    assert.equal(documentWordCount("<p>Two <strong>words</strong></p>"), 2);
    assert.equal(documentWordCount(""), 0);
    // "Clause 1: staff must follow the procedure described here." is nine
    // words ("1:" counts, the colon does not make a word of its own).
    assert.equal(documentWordCount(TEXT), 50 * 9);
  });

  test("the CSV appends read_seconds and reached_end_self_reported after the provenance pair", () => {
    assert.ok(
      ROSTER_CSV_HEADER.endsWith(",version_published_by,version_approved_by,read_seconds,reached_end_self_reported"),
      ROSTER_CSV_HEADER
    );
    assert.ok(ROSTER_CSV_HEADER.startsWith("name,username,email,role,status,acknowledged_at,document,revision_as_of,"), "existing columns stay in place");
    assert.deepEqual(evidenceCsvCells({ acknowledged_at: null, read_seconds: null, reached_end: null }), ["", ""], "pending: both blank");
    assert.deepEqual(evidenceCsvCells({ acknowledged_at: "2026-03-03T10:00:00.000Z", read_seconds: 75, reached_end: true }), [75, "yes"]);
    assert.deepEqual(evidenceCsvCells({ acknowledged_at: "2026-03-03T10:00:00.000Z", read_seconds: null, reached_end: false }), ["", "no"], "confirmed before 1.11.0, or through the API: unknown time, no report");
    assert.deepEqual(evidenceCsvCells({ acknowledged_at: "2026-03-03T10:00:00.000Z", read_seconds: 0, reached_end: false }), [0, "no"], "zero seconds is a value, not unknown");
  });
});

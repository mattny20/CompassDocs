// The confirmation-marker upgrade against a database shaped like 1.9.4,
// booted twice (A1/C5 double-boot idempotency), the 1.10.1 additions
// against a database shaped like 1.10.0, booted twice (the path every real
// upgrade takes), and the 1.12.0 columns and indexes (G1, C2, G3) against a
// database shaped like 1.11.x, booted twice.
//
// The trap this pins: the marker must be backfilled from updated_at so that
// every confirmation 1.9.x showed as current is still current after the
// upgrade, and the one-shot helpers (version inference, the FK swap, the
// provenance backfill) must run exactly once — a second boot must move
// nothing. The catalog checks pin what the 1.10.1 boot guards preserve
// (the users trigger, the history FKs, the spaces default, every index).
// Keep this test in CI for every later release that touches SCHEMA_SQL or
// initialize().
//
// Boots run in a child process (the init promise is cached per process) in
// a database of each describe's own, shaped by hand: a fresh boot, then the
// later additions are stripped back to the older shape before the fixtures
// go in and the upgrade boot runs.
//
// Run: npm run test:integration  (needs DATABASE_URL with CREATE DATABASE)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";

const BASE = process.env.DATABASE_URL ?? "";

function urlFor(db: string): string {
  const u = new URL(BASE);
  u.pathname = `/${db}`;
  return u.toString();
}

/** The init chain (test/support/boot.ts) in a child process against `db`. */
function boot(db: string): { ok: boolean; out: string } {
  return run("test/support/boot.ts", db);
}

/** The hourly audience safety net (reconcileAllPolicies, test/support/reconcile.ts) in a child process against `db`: what the first tick after an upgrade does. */
function reconcile(db: string): { ok: boolean; out: string } {
  return run("test/support/reconcile.ts", db);
}

function run(script: string, db: string): { ok: boolean; out: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.test.json", script],
    {
      env: {
        ...process.env,
        DATABASE_URL: urlFor(db),
        COMPASSDOCS_ADMIN_USER: process.env.COMPASSDOCS_ADMIN_USER || "ackboot_admin",
        COMPASSDOCS_ADMIN_PASSWORD: process.env.COMPASSDOCS_ADMIN_PASSWORD || "AckBoot!12345",
      },
      encoding: "utf8",
      timeout: 180_000,
    }
  );
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: BASE });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Strip the 1.11.0 additions (C3's reading evidence and the doc_views index)
// so the database looks the way 1.10.1 left it.
const DOWNGRADE_1110_SQL = `
  ALTER TABLE acknowledgements DROP COLUMN IF EXISTS read_seconds, DROP COLUMN IF EXISTS reached_end;
  DROP INDEX IF EXISTS idx_views_doc_user;
  ALTER TABLE change_requests DROP COLUMN IF EXISTS ack_policy, DROP COLUMN IF EXISTS ack_reason;
`;

// Strip the 1.10.1 additions so the database looks the way 1.10.0 left it.
const DOWNGRADE_1101_SQL = `
  ${DOWNGRADE_1110_SQL}
  ALTER TABLE documents DROP COLUMN IF EXISTS ack_edit_default;
  DROP TABLE IF EXISTS ack_notices;
  DROP TABLE IF EXISTS ack_outbox;
  ALTER TABLE doc_versions
    DROP COLUMN IF EXISTS published_by, DROP COLUMN IF EXISTS published_by_name,
    DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_by_name,
    DROP COLUMN IF EXISTS change_request_id;
  DELETE FROM settings WHERE key = 'migrated_version_provenance';
  -- 1.13.0 (D1): the audience tables and their one-shot flag, so every upgrade path below materialises the rows.
  DROP TABLE IF EXISTS policy_assignments;
  DROP TABLE IF EXISTS policy_audience_rules;
  DROP TABLE IF EXISTS policy_settings;
  DELETE FROM settings WHERE key = 'policy_assignments_migrated';
`;

// Then strip the 1.10.0 additions so it looks the way 1.9.4 left it.
const DOWNGRADE_SQL = `
  ${DOWNGRADE_1101_SQL}
  ALTER TABLE documents DROP COLUMN ack_revision_at, DROP COLUMN ack_version_id;
  ALTER TABLE acknowledgements
    DROP COLUMN version_id, DROP COLUMN content_sha256,
    DROP COLUMN user_name, DROP COLUMN user_email, DROP COLUMN document_title;
  ALTER TABLE acknowledgements ALTER COLUMN user_id SET NOT NULL, ALTER COLUMN document_id SET NOT NULL;
  ALTER TABLE acknowledgements DROP CONSTRAINT acknowledgements_user_id_fkey;
  ALTER TABLE acknowledgements ADD CONSTRAINT acknowledgements_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE acknowledgements DROP CONSTRAINT acknowledgements_document_id_fkey;
  ALTER TABLE acknowledgements ADD CONSTRAINT acknowledgements_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
  DROP INDEX IF EXISTS idx_ack_user;
  DROP TABLE IF EXISTS attested_texts;
  DROP TABLE IF EXISTS ack_decisions;
  DELETE FROM settings WHERE key IN
    ('migrated_ack_revisions', 'ack_marker_schema', 'migrated_ack_retention', 'ack_retention_schema');
`;

const FLAG_KEYS = [
  "migrated_ack_revisions",
  "ack_marker_schema",
  "migrated_ack_retention",
  "ack_retention_schema",
  "migrated_version_provenance",
  "policy_assignments_migrated",
];
const ALL_FLAGS = [
  "ack_marker_schema=1",
  "ack_retention_schema=1",
  "migrated_ack_retention=1",
  "migrated_ack_revisions=1",
  "migrated_version_provenance=1",
  "policy_assignments_migrated=1",
];

interface Snapshot {
  docs: { id: number; updated_at: string; ack_revision_at: string; ack_version_id: number | null; ack_edit_default: string }[];
  acks: { id: number; version_id: number | null; content_sha256: string | null; user_name: string; current: boolean }[];
  versions: { id: number; published_by_name: string; approved_by_name: string }[];
  flags: string[];
}

async function snapshot(db: Client, docIds: number[]): Promise<Snapshot> {
  const docs = await db.query(
    "SELECT id, updated_at::text, ack_revision_at::text, ack_version_id, ack_edit_default FROM documents WHERE id = ANY($1) ORDER BY id",
    [docIds]
  );
  const acks = await db.query(
    `SELECT a.id, a.version_id, a.content_sha256, a.user_name,
            (a.acknowledged_at >= d.ack_revision_at) AS current
     FROM acknowledgements a JOIN documents d ON d.id = a.document_id
     WHERE a.document_id = ANY($1) ORDER BY a.id`,
    [docIds]
  );
  const versions = await db.query(
    "SELECT id, published_by_name, approved_by_name FROM doc_versions WHERE document_id = ANY($1) ORDER BY id",
    [docIds]
  );
  const flags = await db.query("SELECT key || '=' || value AS kv FROM settings WHERE key = ANY($1) ORDER BY key", [FLAG_KEYS]);
  return { docs: docs.rows, acks: acks.rows, versions: versions.rows, flags: flags.rows.map((r) => r.kv) };
}

/**
 * The 1.10.1 shape and the catalog state the boot guards preserve: the
 * provenance columns and their indexes, ack_edit_default with its default,
 * the two notice tables and their indexes, the users trigger, the history
 * FKs (SET NULL, nullable columns) and the spaces default. Asserted after
 * every boot, so a guard that skips a first-time step, or one that stops
 * recreating something it should, fails here.
 */
async function assertSchema1101(db: Client, label: string) {
  const columns = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'doc_versions'
       AND column_name IN ('published_by','published_by_name','approved_by','approved_by_name','change_request_id')
     ORDER BY column_name`
  );
  assert.deepEqual(
    columns.rows.map((r) => r.column_name),
    ["approved_by", "approved_by_name", "change_request_id", "published_by", "published_by_name"],
    `${label}: the five provenance columns`
  );
  const editDefault = await db.query<{ column_default: string; is_nullable: string }>(
    "SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'documents' AND column_name = 'ack_edit_default'"
  );
  assert.equal(editDefault.rows[0]?.column_default, "'ask'::text", `${label}: ack_edit_default defaults to 'ask'`);
  assert.equal(editDefault.rows[0]?.is_nullable, "NO");
  const tables = await db.query<{ t: string }>("SELECT to_regclass('ack_notices')::text AS t UNION ALL SELECT to_regclass('ack_outbox')::text");
  assert.deepEqual(tables.rows.map((r) => r.t), ["ack_notices", "ack_outbox"], `${label}: the notice tables exist`);
  const indexes = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1) ORDER BY indexname`,
    [
      [
        "idx_doc_versions_published_by",
        "idx_doc_versions_approved_by",
        "idx_ack_notices_user",
        "idx_ack_notices_doc_user_kind",
        "idx_ack_notices_by_user",
        "idx_ack_outbox_due",
        // Three of the guarded CREATE INDEX IF NOT EXISTS statements: a plain
        // one, a gin one and a unique partial one.
        "idx_documents_space",
        "idx_documents_search",
        "idx_ra_user_space",
        // 1.12.0 (G3): the partial indexes under the two SET NULL references.
        "idx_documents_ack_retired_by",
        "idx_documents_ack_superseded_by",
        // 1.13.0 (D1): the audience tables' indexes (the third is partial).
        "idx_policy_rules_doc",
        "idx_policy_assign_user",
        "idx_policy_assign_doc_exempt",
        "idx_policy_assign_due",
      ],
    ]
  );
  // Sorted here, not by the database: the expected order must not depend
  // on the rig's collation.
  assert.deepEqual(
    indexes.rows.map((r) => r.indexname).sort(),
    [
      "idx_ack_notices_by_user",
      "idx_ack_notices_doc_user_kind",
      "idx_ack_notices_user",
      "idx_ack_outbox_due",
      "idx_doc_versions_approved_by",
      "idx_doc_versions_published_by",
      "idx_documents_ack_retired_by",
      "idx_documents_ack_superseded_by",
      "idx_documents_search",
      "idx_documents_space",
      "idx_policy_assign_doc_exempt",
      "idx_policy_assign_due",
      "idx_policy_assign_user",
      "idx_policy_rules_doc",
      "idx_ra_user_space",
    ],
    `${label}: the indexes exist`
  );
  // The OID 1082 text parser in lib/db is process-wide: it must reach
  // exactly one column, so a later `date` column is read as text on purpose.
  const dates = await db.query<{ c: string }>(
    "SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'date' ORDER BY 1"
  );
  // 1.13.0 (E1) adds policy_settings.due_at, a fixed deadline read as its
  // 'YYYY-MM-DD' text on purpose (lib/ack-due endOfDayIn turns the day into
  // the person's due instant).
  assert.deepEqual(
    dates.rows.map((r) => r.c).sort(),
    ["documents.ack_effective_at", "policy_settings.due_at"],
    `${label}: the OID 1082 text parser reaches exactly these columns; a new date column must be read as text on purpose`
  );
  const trigger = await db.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid = 'users'::regclass AND tgname = 'compass_users_ladder_sync' AND NOT tgisinternal"
  );
  assert.equal(trigger.rowCount, 1, `${label}: the users ladder trigger exists`);
  const historyFks = await db.query<{ conname: string; confdeltype: string }>(
    "SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'training_completion_history'::regclass AND contype = 'f' ORDER BY conname"
  );
  assert.deepEqual(
    historyFks.rows.map((r) => [r.conname, r.confdeltype]),
    [
      ["training_completion_history_deck_id_fkey", "n"],
      ["training_completion_history_user_id_fkey", "n"],
    ],
    `${label}: the history FKs are ON DELETE SET NULL`
  );
  const historyNullable = await db.query<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'training_completion_history' AND column_name IN ('user_id','deck_id') ORDER BY column_name"
  );
  assert.deepEqual(historyNullable.rows.map((r) => r.is_nullable), ["YES", "YES"], `${label}: the history columns are nullable`);
  const spacesDefault = await db.query<{ column_default: string }>(
    "SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'spaces' AND column_name = 'visibility'"
  );
  assert.equal(spacesDefault.rows[0]?.column_default, "'internal'::text", `${label}: the spaces default`);
  await assertEvidenceSchema(db, label);
}

/**
 * The 1.11.0 reading evidence (C3): the two columns on acknowledgements with
 * their types, nullability and default, and the doc_views index the read
 * time sum relies on. Asserted after every boot, with the 1.10.1 checks.
 */
async function assertEvidenceSchema(db: Client, label: string) {
  const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'acknowledgements'
       AND column_name IN ('read_seconds', 'reached_end')
     ORDER BY column_name`
  );
  assert.deepEqual(
    columns.rows,
    [
      { column_name: "reached_end", data_type: "integer", is_nullable: "NO", column_default: "0" },
      { column_name: "read_seconds", data_type: "integer", is_nullable: "YES", column_default: null },
    ],
    `${label}: the reading-evidence columns`
  );
  const index = await db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_views_doc_user'"
  );
  assert.equal(index.rows.length, 1, `${label}: idx_views_doc_user exists`);
  assert.match(
    index.rows[0].indexdef,
    /USING btree \(document_id, user_id, viewed_at DESC\)/,
    `${label}: idx_views_doc_user covers (document_id, user_id, viewed_at DESC)`
  );
  // A6: the submitter's recommendation travels on the change request.
  const cr = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'change_requests'
       AND column_name IN ('ack_policy', 'ack_reason')
     ORDER BY column_name`
  );
  assert.deepEqual(
    cr.rows,
    [
      { column_name: "ack_policy", data_type: "text", is_nullable: "NO", column_default: "'auto'::text" },
      { column_name: "ack_reason", data_type: "text", is_nullable: "NO", column_default: "''::text" },
    ],
    `${label}: the change-request decision columns`
  );
}

describe("confirmation marker upgrade (1.9.4 → 1.10.1), booted twice", () => {
  const DB = `compass_ackboot_${process.pid}`;
  let db: Client;

  before(async () => {
    assert.ok(BASE, "DATABASE_URL is set");
    await withAdmin((c) => c.query(`CREATE DATABASE ${DB}`));
    const first = boot(DB);
    assert.ok(first.ok, `fresh boot succeeds:\n${first.out}`);
    db = new Client({ connectionString: urlFor(DB) });
    await db.connect();
    await assertSchema1101(db, "fresh boot");
  });

  after(async () => {
    await db?.end();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
  });

  test("existing confirmations keep their currency, evidence is inferred once, and a second boot moves nothing", async () => {
    await db.query(DOWNGRADE_SQL);

    // A 1.9.4 workspace: one policy edited a day ago (two versions), one
    // reader who confirmed before that edit (stale under 1.9.x) and one who
    // confirmed after it (current under 1.9.x); a second policy nobody
    // confirmed.
    const sp = await db.query<{ id: number }>(
      "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ('Boot', 'boot', '📁', '', 'internal') RETURNING id"
    );
    const spaceId = sp.rows[0].id;
    const users = await db.query<{ id: number }>(
      `INSERT INTO users (username, name, email, role, status) VALUES
         ('boot_early', 'Early Reader', 'early@boot.test', 'viewer', 'active'),
         ('boot_late',  'Late Reader',  'late@boot.test',  'viewer', 'active')
       RETURNING id`
    );
    const [early, late] = users.rows.map((r) => r.id);
    const docs = await db.query<{ id: number }>(
      `INSERT INTO documents (space_id, title, slug, type, status, content, author, ack_required, created_at, updated_at) VALUES
         ($1, 'Boot policy', 'boot-policy', 'policy', 'published', 'v2 text', 'boot', 1,
          now() - interval '3 days', now() - interval '1 day'),
         ($1, 'Quiet policy', 'quiet-policy', 'policy', 'published', 'only text', 'boot', 1,
          now() - interval '3 days', now() - interval '3 days')
       RETURNING id`,
      [spaceId]
    );
    const [policy, quiet] = docs.rows.map((r) => r.id);
    const versions = await db.query<{ id: number }>(
      `INSERT INTO doc_versions (document_id, title, content, author, note, created_at) VALUES
         ($1, 'Boot policy', 'v1 text', 'boot', 'Created', now() - interval '3 days'),
         ($1, 'Boot policy', 'v2 text', 'boot', 'Edited',  now() - interval '1 day'),
         ($2, 'Quiet policy', 'only text', 'boot', 'Created', now() - interval '3 days')
       RETURNING id`,
      [policy, quiet]
    );
    const [v1, v2, quietV1] = versions.rows.map((r) => r.id);
    await db.query(
      `INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip) VALUES
         ($1, $2, now() - interval '2 days', '10.0.0.1'),
         ($1, $3, now() - interval '12 hours', '10.0.0.2')`,
      [policy, early, late]
    );
    const legacy = await db.query<{ user_id: number; current: boolean }>(
      `SELECT a.user_id, (a.acknowledged_at >= d.updated_at) AS current
       FROM acknowledgements a JOIN documents d ON d.id = a.document_id WHERE d.id = $1 ORDER BY a.id`,
      [policy]
    );
    assert.deepEqual(
      legacy.rows.map((r) => r.current),
      [false, true],
      "what 1.9.4 showed: early stale, late current"
    );

    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    assert.match(upgrade.out, /\[ack\] stamped the confirmation marker/, "the version backfill ran and logged its counts");
    assert.match(upgrade.out, /\[ack\] attestation records now outlive/, "the retention migration ran");
    // The counts include the sample documents seedIfEmpty wrote on the
    // fresh boot (their versions lost the columns in the downgrade too), so
    // they are a floor; the three fixture versions are checked row by row
    // below.
    const backfill = /\[ack\] version provenance backfilled: (\d+) publisher name\(s\) and (\d+) approver name\(s\)/.exec(upgrade.out);
    assert.ok(backfill, `the provenance backfill ran and logged its counts:\n${upgrade.out}`);
    assert.ok(Number(backfill![1]) >= 3, "at least the three fixture versions got a publisher name");
    assert.equal(Number(backfill![2]), 0, "no version carries an approval note");
    await assertSchema1101(db, "upgrade boot");

    const once = await snapshot(db, [policy, quiet]);
    for (const d of once.docs) {
      assert.equal(d.ack_revision_at, d.updated_at, `document ${d.id}: the marker is the old updated_at, not upgrade time`);
      assert.equal(d.ack_edit_default, "ask", `document ${d.id}: an existing policy starts on 'ask'`);
    }
    assert.equal(once.docs.find((d) => d.id === policy)!.ack_version_id, v2, "the marker's version is the newest");
    assert.equal(once.docs.find((d) => d.id === quiet)!.ack_version_id, quietV1);
    assert.deepEqual(
      once.acks.map((a) => a.current),
      [false, true],
      "currency after the upgrade matches what 1.9.4 showed"
    );
    assert.deepEqual(
      once.acks.map((a) => a.version_id),
      [v1, v2],
      "each row cites the newest version that existed when it was made"
    );
    assert.deepEqual(once.acks.map((a) => a.content_sha256), [null, null], "inferred rows carry no hash");
    assert.deepEqual(once.acks.map((a) => a.user_name), ["Early Reader", "Late Reader"], "name snapshots backfilled");
    assert.deepEqual(
      once.versions.map((v) => [v.published_by_name, v.approved_by_name]),
      [
        ["boot", ""],
        ["boot", ""],
        ["boot", ""],
      ],
      "the publisher name comes from the byline; no approval note, no approver"
    );
    assert.deepEqual(once.flags, ALL_FLAGS);
    const fks = await db.query<{ conname: string; confdeltype: string; convalidated: boolean }>(
      "SELECT conname, confdeltype, convalidated FROM pg_constraint WHERE conrelid = 'acknowledgements'::regclass AND contype = 'f' ORDER BY conname"
    );
    assert.deepEqual(
      fks.rows.map((r) => [r.conname, r.confdeltype, r.convalidated]),
      [
        ["acknowledgements_document_id_fkey", "n", true],
        ["acknowledgements_user_id_fkey", "n", true],
      ],
      "both FKs are ON DELETE SET NULL and validated"
    );
    const notNull = await db.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'acknowledgements' AND column_name IN ('user_id','document_id') ORDER BY column_name"
    );
    assert.deepEqual(notNull.rows.map((r) => r.is_nullable), ["YES", "YES"]);
    const marker = await db.query<{ is_nullable: string; column_default: string }>(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'ack_revision_at'"
    );
    assert.equal(marker.rows[0].is_nullable, "NO");
    assert.equal(marker.rows[0].column_default, "now()");

    // Something a tenant does between boots that a re-run would undo: a
    // confirmation whose inferred version was cleared, and a publisher name
    // corrected by hand. A second boot must leave both alone (the inference
    // and the backfill are one-shot). And something a re-run must catch: a
    // document created while the workspace was rolled back to 1.9.x
    // arrives without a marker version (1.9.x's createDocument writes none)
    // and gets one on the next boot.
    await db.query("UPDATE acknowledgements SET version_id = NULL WHERE user_id = $1", [early]);
    await db.query("UPDATE doc_versions SET published_by_name = '' WHERE id = $1", [v1]);
    const between = await snapshot(db, [policy, quiet]);
    const latePolicy = (
      await db.query<{ id: number }>(
        `INSERT INTO documents (space_id, title, slug, type, status, content, author, ack_required)
         VALUES ($1, 'Late policy', 'late-policy', 'policy', 'published', 'late text', 'boot', 1) RETURNING id`,
        [spaceId]
      )
    ).rows[0].id;
    const latePolicyV1 = (
      await db.query<{ id: number }>(
        "INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, 'Late policy', 'late text', 'boot', 'Created') RETURNING id",
        [latePolicy]
      )
    ).rows[0].id;

    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.doesNotMatch(second.out, /inferred the version/, "the confirmation inference did not run again");
    assert.doesNotMatch(second.out, /attestation records now outlive/, "the retention migration did not run again");
    assert.doesNotMatch(second.out, /version provenance backfilled/, "the provenance backfill did not run again");
    assert.match(second.out, /\[ack\] stamped the confirmation marker on 1 document\(s\) created without one/);
    await assertSchema1101(db, "second boot");
    const twice = await snapshot(db, [policy, quiet]);
    assert.deepEqual(twice, between, "nothing moved on the second boot");
    const stamped = await db.query("SELECT ack_version_id FROM documents WHERE id = $1", [latePolicy]);
    assert.equal(stamped.rows[0].ack_version_id, latePolicyV1, "the late document's marker is its newest version");
    assert.deepEqual(
      (await snapshot(db, [policy, quiet])).flags,
      between.flags,
      "the one-shot flags are as they were"
    );
  });

  test("1.12.0 (G3): the retirement columns, their SET NULL references and the two partial indexes come back on an upgrade boot, every existing document stays unretired, a retirement set between boots survives, and a second boot moves nothing", async () => {
    // A database shaped like 1.11.x: the five columns gone (their two
    // foreign keys and the two partial indexes go with them).
    await db.query(`
      ALTER TABLE documents
        DROP COLUMN IF EXISTS ack_retired_at,
        DROP COLUMN IF EXISTS ack_retired_by,
        DROP COLUMN IF EXISTS ack_retired_by_name,
        DROP COLUMN IF EXISTS ack_retired_reason,
        DROP COLUMN IF EXISTS ack_superseded_by;
    `);
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    await assertSchema1101(db, "1.12.0 (G3) upgrade boot");

    const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'documents'
         AND column_name IN ('ack_retired_at', 'ack_retired_by', 'ack_retired_by_name', 'ack_retired_reason', 'ack_superseded_by')
       ORDER BY column_name`
    );
    assert.deepEqual(
      columns.rows,
      [
        { column_name: "ack_retired_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
        { column_name: "ack_retired_by", data_type: "integer", is_nullable: "YES", column_default: null },
        { column_name: "ack_retired_by_name", data_type: "text", is_nullable: "NO", column_default: "''::text" },
        { column_name: "ack_retired_reason", data_type: "text", is_nullable: "NO", column_default: "''::text" },
        { column_name: "ack_superseded_by", data_type: "integer", is_nullable: "YES", column_default: null },
      ],
      "the five retirement columns, metadata-only"
    );
    // A deleted account or a purged replacement clears the reference; the
    // retirement itself (the stamp, the name, the reason) is never cascaded.
    const fks = async () =>
      (
        await db.query<{ conname: string; confdeltype: string; ref: string }>(
          `SELECT conname, confdeltype, confrelid::regclass::text AS ref FROM pg_constraint
           WHERE conrelid = 'documents'::regclass AND contype = 'f'
             AND conname IN ('documents_ack_retired_by_fkey', 'documents_ack_superseded_by_fkey')
           ORDER BY conname`
        )
      ).rows.map((r) => [r.conname, r.confdeltype, r.ref]);
    const expectedFks = [
      ["documents_ack_retired_by_fkey", "n", "users"],
      ["documents_ack_superseded_by_fkey", "n", "documents"],
    ];
    assert.deepEqual(await fks(), expectedFks, "both references are ON DELETE SET NULL");
    // The upgrade left every existing document unretired.
    const retired = await db.query("SELECT COUNT(*)::int AS n FROM documents WHERE ack_retired_at IS NOT NULL OR ack_required IS NULL");
    assert.equal(retired.rows[0].n, 0);

    // A retirement set between boots (what retirePolicy writes, done by hand
    // so the boot is the only code under test) survives the next boot
    // untouched, references and all.
    const [policy, replacement] = (await db.query<{ id: number }>("SELECT id FROM documents WHERE ack_required = 1 ORDER BY id LIMIT 2")).rows.map(
      (r) => r.id
    );
    assert.ok(policy && replacement, "two fixture policies require confirmation");
    const manager = (await db.query<{ id: number }>("SELECT id FROM users WHERE username = 'boot_late'")).rows[0].id;
    await db.query(
      `UPDATE documents
         SET ack_required = 0, ack_retired_at = '2026-05-01T09:00:00Z', ack_retired_by = $2, ack_retired_by_name = 'Late Reader',
             ack_retired_reason = 'Superseded by hand', ack_superseded_by = $3
       WHERE id = $1`,
      [policy, manager, replacement]
    );
    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    const kept = await db.query<{
      ack_required: number;
      ack_retired_at: Date;
      ack_retired_by: number;
      ack_retired_by_name: string;
      ack_retired_reason: string;
      ack_superseded_by: number;
    }>(
      "SELECT ack_required, ack_retired_at, ack_retired_by, ack_retired_by_name, ack_retired_reason, ack_superseded_by FROM documents WHERE id = $1",
      [policy]
    );
    const { ack_retired_at, ...rest } = kept.rows[0];
    assert.equal(new Date(ack_retired_at).toISOString(), "2026-05-01T09:00:00.000Z", "the stamp is as written");
    assert.deepEqual(
      rest,
      { ack_required: 0, ack_retired_by: manager, ack_retired_by_name: "Late Reader", ack_retired_reason: "Superseded by hand", ack_superseded_by: replacement },
      "the retirement is as written"
    );
    assert.deepEqual(await fks(), expectedFks, "the references are still there");
    assert.equal(
      (await db.query("SELECT COUNT(*)::int AS n FROM documents WHERE ack_retired_at IS NOT NULL")).rows[0].n,
      1,
      "no other document was retired"
    );
    await assertSchema1101(db, "1.12.0 (G3) second boot");
  });
});

describe("the 1.10.1 additions against a 1.10.0 database, booted twice", () => {
  const DB = `compass_ackboot110_${process.pid}`;
  let db: Client;

  before(async () => {
    assert.ok(BASE, "DATABASE_URL is set");
    await withAdmin((c) => c.query(`CREATE DATABASE ${DB}`));
    const first = boot(DB);
    assert.ok(first.ok, `fresh boot succeeds:\n${first.out}`);
    db = new Client({ connectionString: urlFor(DB) });
    await db.connect();
  });

  after(async () => {
    await db?.end();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
  });

  test("provenance is backfilled once from the byline and the approval note, the marker and the record are untouched, and a second boot moves nothing", async () => {
    await db.query(DOWNGRADE_1101_SQL);

    // A 1.10.0 workspace: a required policy with two versions, the second
    // through a change request (the legacy note suffix names the approver),
    // its marker on the second version, one current confirmation, and a
    // reset decision in the ledger.
    const sp = await db.query<{ id: number }>(
      "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ('Boot 1.10', 'boot-110', '📁', '', 'internal') RETURNING id"
    );
    const spaceId = sp.rows[0].id;
    const reader = (
      await db.query<{ id: number }>(
        "INSERT INTO users (username, name, email, role, status) VALUES ('boot110_reader', 'Boot Reader', 'reader@boot110.test', 'viewer', 'active') RETURNING id"
      )
    ).rows[0].id;
    const policy = (
      await db.query<{ id: number }>(
        `INSERT INTO documents (space_id, title, slug, type, status, content, author, ack_required, created_at, updated_at, ack_revision_at)
         VALUES ($1, 'Boot 1.10 policy', 'boot-110-policy', 'policy', 'published', 'second text', 'boot', 1,
                 now() - interval '3 days', now() - interval '1 day', now() - interval '1 day') RETURNING id`,
        [spaceId]
      )
    ).rows[0].id;
    const versions = await db.query<{ id: number }>(
      `INSERT INTO doc_versions (document_id, title, content, author, note, created_at) VALUES
         ($1, 'Boot 1.10 policy', 'first text', 'boot', 'Created', now() - interval '3 days'),
         ($1, 'Boot 1.10 policy', 'second text', 'Dana Writer', 'Cap raised — approved by Priya Patel', now() - interval '1 day')
       RETURNING id`,
      [policy]
    );
    const [v1, v2] = versions.rows.map((r) => r.id);
    await db.query("UPDATE documents SET ack_version_id = $2 WHERE id = $1", [policy, v2]);
    await db.query(
      `INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip, version_id, content_sha256, user_name, user_email, document_title)
       VALUES ($1, $2, now() - interval '12 hours', '10.0.0.3', $3, 'abc', 'Boot Reader', 'reader@boot110.test', 'Boot 1.10 policy')`,
      [policy, reader, v2]
    );
    await db.query(
      `INSERT INTO ack_decisions (document_id, document_title, version_id, outcome, decided_at, source, decided_by_name, reason, confirmations_affected, eligible)
       VALUES ($1, 'Boot 1.10 policy', $2, 'reset', now() - interval '1 day', 'approval', 'Priya Patel', 'Cap raised', 1, 1)`,
      [policy, v2]
    );
    const before = await db.query("SELECT ack_revision_at::text AS marker, ack_version_id FROM documents WHERE id = $1", [policy]);

    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    // The publisher count includes the sample documents seedIfEmpty wrote on
    // the fresh boot, so it is a floor; the one approver is the fixture's.
    const backfill = /\[ack\] version provenance backfilled: (\d+) publisher name\(s\) and (\d+) approver name\(s\)/.exec(upgrade.out);
    assert.ok(backfill, `the provenance backfill ran and logged its counts:\n${upgrade.out}`);
    assert.ok(Number(backfill![1]) >= 2, "at least the two fixture versions got a publisher name");
    assert.equal(Number(backfill![2]), 1, "the one legacy approval note became an approver name");
    // The 1.10.0 one-shots are already recorded in this database: the
    // version inference and the retention migration do not run again (the
    // sample documents' markers are stamped by the flag-guarded repair,
    // which is a different line).
    assert.doesNotMatch(upgrade.out, /inferred the version/, "the 1.10.0 version inference did not run again");
    assert.doesNotMatch(upgrade.out, /attestation records now outlive/, "the 1.10.0 retention migration is already done");
    await assertSchema1101(db, "upgrade boot");

    const once = await snapshot(db, [policy]);
    assert.deepEqual(
      once.versions.map((v) => [v.id, v.published_by_name, v.approved_by_name]),
      [
        [v1, "boot", ""],
        [v2, "Dana Writer", "Priya Patel"],
      ],
      "the publisher from the byline, the approver from the legacy note"
    );
    assert.equal(once.docs[0].ack_revision_at, before.rows[0].marker, "the marker did not move");
    assert.equal(once.docs[0].ack_version_id, v2);
    assert.equal(once.docs[0].ack_edit_default, "ask", "an existing policy starts on 'ask'");
    assert.deepEqual(once.acks.map((a) => [a.version_id, a.content_sha256, a.current]), [[v2, "abc", true]], "the record is as it was");
    assert.deepEqual(once.flags, ALL_FLAGS);
    const ledger = await db.query("SELECT outcome, source, notified_at FROM ack_decisions WHERE document_id = $1", [policy]);
    assert.deepEqual(ledger.rows, [{ outcome: "reset", source: "approval", notified_at: null }], "the ledger row is as it was");
    const outbox = await db.query("SELECT COUNT(*)::int AS n FROM ack_outbox");
    assert.equal(outbox.rows[0].n, 0, "nothing is queued for what happened before the upgrade");

    // A name corrected by hand between boots stays corrected: the backfill
    // is one-shot.
    await db.query("UPDATE doc_versions SET published_by_name = 'Dana W.' WHERE id = $1", [v2]);
    const between = await snapshot(db, [policy]);

    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.doesNotMatch(second.out, /version provenance backfilled/, "the backfill did not run again");
    await assertSchema1101(db, "second boot");
    assert.deepEqual(await snapshot(db, [policy]), between, "nothing moved on the second boot");
  });

  test("1.12.0 (G1): the re-confirmation columns and their partial index come back on an upgrade boot, existing policies get no cycle, values set between boots survive, and a second boot moves nothing", async () => {
    // A database shaped like 1.11.x: the three columns and the index gone.
    await db.query(`
      DROP INDEX IF EXISTS idx_documents_ack_recert;
      ALTER TABLE documents
        DROP COLUMN IF EXISTS ack_recert_months,
        DROP COLUMN IF EXISTS ack_next_recert_at,
        DROP COLUMN IF EXISTS ack_effective_at;
    `);
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);

    const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'documents'
         AND column_name IN ('ack_recert_months', 'ack_next_recert_at', 'ack_effective_at')
       ORDER BY column_name`
    );
    assert.deepEqual(
      columns.rows,
      [
        { column_name: "ack_effective_at", data_type: "date", is_nullable: "YES", column_default: null },
        { column_name: "ack_next_recert_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
        { column_name: "ack_recert_months", data_type: "integer", is_nullable: "YES", column_default: null },
      ],
      "the three re-confirmation columns, nullable with no default (metadata-only)"
    );
    const index = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_ack_recert'"
    );
    assert.equal(index.rows.length, 1, "idx_documents_ack_recert exists");
    assert.match(
      index.rows[0].indexdef,
      /USING btree \(ack_next_recert_at\) WHERE \(\(ack_required = 1\) AND \(ack_recert_months IS NOT NULL\)\)/,
      "the partial index covers exactly the rows the sweep tests"
    );
    // The upgrade dates nothing and starts no cycle: an existing policy is
    // asked again only once someone sets an interval.
    const existing = await db.query<{ ack_recert_months: number | null; ack_next_recert_at: string | null; ack_effective_at: string | null }>(
      "SELECT ack_recert_months, ack_next_recert_at, ack_effective_at::text AS ack_effective_at FROM documents WHERE ack_required = 1"
    );
    assert.ok(existing.rows.length >= 1, "the fixture policy still requires confirmation");
    assert.ok(
      existing.rows.every((r) => r.ack_recert_months === null && r.ack_next_recert_at === null && r.ack_effective_at === null),
      "no cycle and no effective date on an existing policy"
    );

    // A cycle set between boots survives the next one untouched.
    const dated = await db.query<{ id: number }>("SELECT id FROM documents WHERE ack_required = 1 ORDER BY id LIMIT 1");
    const docId = dated.rows[0].id;
    await db.query(
      "UPDATE documents SET ack_recert_months = 12, ack_next_recert_at = '2027-01-01T00:00:00Z', ack_effective_at = '2026-01-01' WHERE id = $1",
      [docId]
    );
    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    const kept = await db.query<{ ack_recert_months: number; next: string; eff: string }>(
      "SELECT ack_recert_months, ack_next_recert_at::text AS next, ack_effective_at::text AS eff FROM documents WHERE id = $1",
      [docId]
    );
    assert.equal(kept.rows[0].ack_recert_months, 12);
    assert.equal(kept.rows[0].eff, "2026-01-01");
    assert.match(kept.rows[0].next, /^2027-01-01 00:00:00/);
    assert.equal(
      (await db.query("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_documents_ack_recert'")).rowCount,
      1,
      "the index is still there after the second boot"
    );
    await assertSchema1101(db, "1.12.0 second boot");
  });

  test("1.12.0 (C2): the statement and signature columns come back on an upgrade boot with their defaults, a 1.11.x-shaped confirmation still inserts, values set between boots survive, and a second boot moves nothing", async () => {
    // A database shaped like 1.11.x: the two document columns and the four
    // record columns gone.
    await db.query(`
      ALTER TABLE documents DROP COLUMN IF EXISTS ack_statement, DROP COLUMN IF EXISTS ack_signature;
      ALTER TABLE acknowledgements
        DROP COLUMN IF EXISTS statement_text, DROP COLUMN IF EXISTS signed_name,
        DROP COLUMN IF EXISTS identity_proof, DROP COLUMN IF EXISTS user_agent;
    `);
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);

    const shape = async () =>
      (
        await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
          `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND ((table_name = 'documents' AND column_name IN ('ack_statement', 'ack_signature'))
               OR (table_name = 'acknowledgements' AND column_name IN ('statement_text', 'signed_name', 'identity_proof', 'user_agent')))
           ORDER BY table_name, column_name`
        )
      ).rows;
    const expected = [
      { table_name: "acknowledgements", column_name: "identity_proof", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      { table_name: "acknowledgements", column_name: "signed_name", data_type: "text", is_nullable: "YES", column_default: null },
      { table_name: "acknowledgements", column_name: "statement_text", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      { table_name: "acknowledgements", column_name: "user_agent", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      { table_name: "documents", column_name: "ack_signature", data_type: "integer", is_nullable: "NO", column_default: "0" },
      { table_name: "documents", column_name: "ack_statement", data_type: "text", is_nullable: "YES", column_default: null },
    ];
    assert.deepEqual(await shape(), expected, "the six columns with their defaults (metadata-only: constant defaults, no backfill)");

    // The upgrade changes no policy's behaviour: the workspace default
    // statement and no signature; existing rows read as unsigned with no
    // statement text (they predate the column).
    const docs = await db.query<{ ack_statement: string | null; ack_signature: number }>(
      "SELECT ack_statement, ack_signature FROM documents WHERE ack_required = 1"
    );
    assert.ok(docs.rows.length >= 1, "the fixture policy still requires confirmation");
    assert.ok(docs.rows.every((r) => r.ack_statement === null && r.ack_signature === 0), "default statement, no signature");
    const acks = await db.query<{ statement_text: string; signed_name: string | null; identity_proof: string; user_agent: string }>(
      "SELECT statement_text, signed_name, identity_proof, user_agent FROM acknowledgements"
    );
    assert.ok(acks.rows.length >= 1, "the fixture confirmation is still there");
    assert.ok(
      acks.rows.every((r) => r.statement_text === "" && r.signed_name === null && r.identity_proof === "" && r.user_agent === ""),
      "existing rows are unsigned with no statement text"
    );

    // A 1.11.x-shaped INSERT (what a 1.11.2 binary writes during a rollback)
    // takes the defaults.
    const policy = (await db.query<{ id: number }>("SELECT id FROM documents WHERE ack_required = 1 ORDER BY id LIMIT 1")).rows[0].id;
    const reader = (await db.query<{ id: number }>("SELECT id FROM users WHERE username = 'boot110_reader'")).rows[0].id;
    const legacy = await db.query<{ id: number; statement_text: string; signed_name: string | null; identity_proof: string; user_agent: string }>(
      `INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip, version_id, content_sha256, user_name, user_email, document_title)
       VALUES ($1, $2, now(), '10.0.0.4', NULL, NULL, 'Boot Reader', 'reader@boot110.test', 'Boot 1.10 policy')
       RETURNING id, statement_text, signed_name, identity_proof, user_agent`,
      [policy, reader]
    );
    const { id: legacyId, ...legacyRow } = legacy.rows[0];
    assert.deepEqual(legacyRow, { statement_text: "", signed_name: null, identity_proof: "", user_agent: "" });

    // Values set between boots survive the next one untouched.
    await db.query("UPDATE documents SET ack_statement = 'I will comply.', ack_signature = 1 WHERE id = $1", [policy]);
    await db.query(
      "UPDATE acknowledgements SET statement_text = 'I will comply.', signed_name = 'Boot Reader', identity_proof = 'password', user_agent = 'BootTest/1' WHERE id = $1",
      [legacyId]
    );
    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.deepEqual(await shape(), expected, "the second boot leaves the shape alone");
    const keptDoc = await db.query<{ ack_statement: string | null; ack_signature: number }>(
      "SELECT ack_statement, ack_signature FROM documents WHERE id = $1",
      [policy]
    );
    assert.deepEqual(keptDoc.rows[0], { ack_statement: "I will comply.", ack_signature: 1 });
    const keptRow = await db.query<{ statement_text: string; signed_name: string | null; identity_proof: string; user_agent: string }>(
      "SELECT statement_text, signed_name, identity_proof, user_agent FROM acknowledgements WHERE id = $1",
      [legacyId]
    );
    assert.deepEqual(keptRow.rows[0], { statement_text: "I will comply.", signed_name: "Boot Reader", identity_proof: "password", user_agent: "BootTest/1" });
    await assertSchema1101(db, "1.12.0 (C2) second boot");
  });

  test("1.13.0 (E1): spaces.policy_defaults comes back on an upgrade boot as jsonb NOT NULL DEFAULT '{}', every existing space inherits everything, a 1.12.0-shaped INSERT takes the default, a value set between boots survives, and a second boot moves nothing", async () => {
    // A database shaped like 1.12.0: the column gone.
    await db.query("ALTER TABLE spaces DROP COLUMN IF EXISTS policy_defaults");
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);

    const column = async () =>
      (
        await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
          `SELECT data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'spaces' AND column_name = 'policy_defaults'`
        )
      ).rows;
    const expected = [{ data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" }];
    assert.deepEqual(await column(), expected, "the column with its constant default (metadata-only: no backfill)");
    // The upgrade changes no space's behaviour: every space inherits the
    // workspace defaults until an admin sets something on it.
    const spaces = await db.query<{ n: number; empty: number }>(
      "SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE policy_defaults = '{}'::jsonb)::int AS empty FROM spaces"
    );
    assert.ok(spaces.rows[0].n >= 1, "the fixture space is there");
    assert.equal(spaces.rows[0].empty, spaces.rows[0].n, "every existing space reads as inheriting everything");

    // A 1.12.0-shaped INSERT (what a rolled-back binary writes) takes the default.
    const legacy = await db.query<{ id: number; policy_defaults: unknown }>(
      "INSERT INTO spaces (name, slug, icon, description, visibility) VALUES ('Boot 1.13 legacy', 'boot-113-legacy', '📁', '', 'internal') RETURNING id, policy_defaults"
    );
    assert.deepEqual(legacy.rows[0].policy_defaults, {});

    // A layer set between boots (what PATCH /api/admin/spaces/[id] writes,
    // done by hand so the boot is the only code under test) survives.
    const spaceId = (await db.query<{ id: number }>("SELECT id FROM spaces ORDER BY id LIMIT 1")).rows[0].id;
    await db.query(`UPDATE spaces SET policy_defaults = '{"due_days": 30, "remind_every_days": 3, "owner_user_id": 1}' WHERE id = $1`, [spaceId]);
    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.deepEqual(await column(), expected, "the second boot leaves the shape alone");
    assert.deepEqual(
      (await db.query<{ policy_defaults: unknown }>("SELECT policy_defaults FROM spaces WHERE id = $1", [spaceId])).rows[0].policy_defaults,
      { due_days: 30, remind_every_days: 3, owner_user_id: 1 },
      "the layer is as written"
    );
    assert.deepEqual(
      (await db.query<{ policy_defaults: unknown }>("SELECT policy_defaults FROM spaces WHERE id = $1", [legacy.rows[0].id])).rows[0].policy_defaults,
      {},
      "the legacy insert still inherits"
    );
    await assertSchema1101(db, "1.13.0 (E1) second boot");
  });

  test("1.13.0 (E2): the ack_outbox payload column comes back on an upgrade boot, nullable with no default, a 1.12.0-shaped queue row still inserts, a payload set between boots survives, and a second boot moves nothing", async () => {
    // A database shaped like 1.12.0: the column gone.
    await db.query("ALTER TABLE ack_outbox DROP COLUMN IF EXISTS payload");
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    const column = async () =>
      (
        await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
          "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ack_outbox' AND column_name = 'payload'"
        )
      ).rows;
    const expected = [{ data_type: "jsonb", is_nullable: "YES", column_default: null }];
    assert.deepEqual(await column(), expected, "payload jsonb, nullable, no default (metadata-only)");

    // What a 1.12.0 binary writes (no payload) still inserts and reads as NULL.
    const policy = (await db.query<{ id: number }>("SELECT id FROM documents WHERE ack_required = 1 ORDER BY id LIMIT 1")).rows[0].id;
    const legacy = await db.query<{ id: number; payload: unknown }>(
      "INSERT INTO ack_outbox (document_id, mode, source, actor_name) VALUES ($1, 'reminder', 'manual', 'Boot') RETURNING id, payload",
      [policy]
    );
    assert.equal(legacy.rows[0].payload, null);
    // A sweep row set between boots survives the next one untouched.
    await db.query(`UPDATE ack_outbox SET payload = '{"rows": [{"user_id": 1, "due_at": null, "overdue": false}]}' WHERE id = $1`, [legacy.rows[0].id]);
    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.deepEqual(await column(), expected, "the second boot leaves the shape alone");
    assert.deepEqual(
      (await db.query<{ payload: unknown }>("SELECT payload FROM ack_outbox WHERE id = $1", [legacy.rows[0].id])).rows[0].payload,
      { rows: [{ user_id: 1, due_at: null, overdue: false }] },
      "the payload is as written"
    );
    await db.query("DELETE FROM ack_outbox WHERE id = $1", [legacy.rows[0].id]);
    await assertSchema1101(db, "1.13.0 (E2) second boot");
  });

  test("1.13.0 (D1): the three audience tables, their indexes and the UNIQUE come back on an upgrade boot; every person who owed a policy under 1.12.0 gets one open row dated from the marker, so the KPI sums and every roster are identical before and after; the flag is set; and a second boot moves nothing", async () => {
    // A database shaped like 1.12.0: the three tables and the one-shot flag gone.
    await db.query(`
      DROP TABLE IF EXISTS policy_assignments;
      DROP TABLE IF EXISTS policy_audience_rules;
      DROP TABLE IF EXISTS policy_settings;
      DELETE FROM settings WHERE key = 'policy_assignments_migrated';
    `);
    // More shape: a second active reader, a disabled one (never in the
    // denominator), and a second policy nobody confirmed, all as 1.12.0
    // wrote them.
    const spaceId = (await db.query<{ space_id: number }>("SELECT space_id FROM documents WHERE ack_required = 1 ORDER BY id LIMIT 1")).rows[0].space_id;
    await db.query(
      `INSERT INTO users (username, name, email, role, status) VALUES
         ('boot110_second', 'Second Reader', 'second@boot110.test', 'viewer', 'active'),
         ('boot110_gone', 'Gone Reader', 'gone@boot110.test', 'viewer', 'disabled')`
    );
    const quiet = (
      await db.query<{ id: number }>(
        `INSERT INTO documents (space_id, title, slug, type, status, content, author, ack_required)
         VALUES ($1, 'Boot 1.13 quiet policy', 'boot-113-quiet', 'policy', 'published', 'quiet text', 'boot', 1) RETURNING id`,
        [spaceId]
      )
    ).rows[0].id;
    await db.query("INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, 'Boot 1.13 quiet policy', 'quiet text', 'boot', 'Created')", [quiet]);
    // What 1.12.0 showed, per policy: everyone active who can see the space
    // (the fixture spaces are internal, so every active account) and who is
    // current against the marker.
    const LEGACY = `SELECT d.id AS document_id, u.id AS user_id,
                           EXISTS (SELECT 1 FROM acknowledgements a WHERE a.document_id = d.id AND a.user_id = u.id
                                     AND a.acknowledged_at >= d.ack_revision_at) AS current
                    FROM documents d JOIN spaces s ON s.id = d.space_id JOIN users u ON u.status = 'active'
                    WHERE (d.ack_required = 1 OR d.ack_retired_at IS NOT NULL) AND s.visibility IN ('public', 'internal')
                    ORDER BY 1, 2`;
    const before = (await db.query(LEGACY)).rows;
    assert.ok(before.length >= 6, `the fixture has policies and people (${before.length})`);
    assert.ok(before.some((r) => r.current), "and at least one current confirmation");
    const privateSpaces = await db.query("SELECT COUNT(*)::int AS n FROM documents d JOIN spaces s ON s.id = d.space_id WHERE d.ack_required = 1 AND s.visibility = 'private'");
    assert.equal(privateSpaces.rows[0].n, 0, "the legacy rule above is the whole audience: no private-space policy in this database");

    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    assert.match(upgrade.out, /\[ack\] policy audiences materialised: \d+ policy setting row\(s\) and \d+ assignment\(s\)/, "the migration ran and logged its counts");
    await assertSchema1101(db, "1.13.0 (D1) upgrade boot");

    const tables = await db.query<{ t: string }>(
      "SELECT to_regclass('policy_settings')::text AS t UNION ALL SELECT to_regclass('policy_audience_rules')::text UNION ALL SELECT to_regclass('policy_assignments')::text"
    );
    assert.deepEqual(tables.rows.map((r) => r.t), ["policy_settings", "policy_audience_rules", "policy_assignments"], "the three tables exist");
    const unique = await db.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'policy_assignments'::regclass AND contype = 'u'"
    );
    assert.deepEqual(unique.rows.map((r) => r.def), ["UNIQUE (document_id, user_id)"], "one row per person and policy");
    const rulesUnique = await db.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'policy_audience_rules'::regclass AND contype = 'u'"
    );
    assert.deepEqual(rulesUnique.rows.map((r) => r.def), ["UNIQUE (document_id, kind, ref, effect)"]);
    // The FK ON DELETE rules: what keeps a 1.12.0 binary's deleteUser and
    // document purge from failing on the new tables during a rollback
    // (cascade), and a deleted owner or requester reading as nobody.
    const fks = await db.query<{ t: string; conname: string; confdeltype: string }>(
      `SELECT conrelid::regclass::text AS t, conname, confdeltype FROM pg_constraint
       WHERE contype = 'f' AND conrelid IN ('policy_settings'::regclass, 'policy_audience_rules'::regclass, 'policy_assignments'::regclass)
       ORDER BY 1, 2`
    );
    assert.deepEqual(
      fks.rows.map((r) => [r.t, r.conname, r.confdeltype]),
      [
        ["policy_assignments", "policy_assignments_document_id_fkey", "c"],
        ["policy_assignments", "policy_assignments_user_id_fkey", "c"],
        ["policy_audience_rules", "policy_audience_rules_document_id_fkey", "c"],
        // 1.14.0 (D3): the set that wrote a rule; a deleted set leaves the rule untagged.
        ["policy_audience_rules", "policy_audience_rules_set_id_fkey", "n"],
        ["policy_settings", "policy_settings_document_id_fkey", "c"],
        ["policy_settings", "policy_settings_owner_user_id_fkey", "n"],
        ["policy_settings", "policy_settings_requested_by_fkey", "n"],
      ],
      "the seven FKs: CASCADE for the three document_id and the user_id, SET NULL for the owner, the requester and the rule's set"
    );
    const partial = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_policy_assign_due'"
    );
    assert.match(partial.rows[0].indexdef, /USING btree \(due_at\) WHERE \(\(exempt_at IS NULL\) AND \(removed_at IS NULL\)\)/, "the due index covers the open rows only");
    assert.equal(
      (await db.query("SELECT value FROM settings WHERE key = 'policy_assignments_migrated'")).rows[0]?.value,
      "1",
      "the one-shot flag is set"
    );

    // The rows: the same people, the same currency, every row open, source
    // 'space', the cycle dated from the marker (not the upgrade), one
    // settings row per policy in space mode.
    const AFTER = `SELECT pa.document_id, pa.user_id,
                          EXISTS (SELECT 1 FROM acknowledgements a WHERE a.document_id = d.id AND a.user_id = u.id
                                    AND a.acknowledged_at >= GREATEST(d.ack_revision_at, pa.cycle_started_at)) AS current
                   FROM policy_assignments pa
                   JOIN documents d ON d.id = pa.document_id
                   JOIN users u ON u.id = pa.user_id AND u.status = 'active'
                   WHERE pa.removed_at IS NULL AND pa.exempt_at IS NULL
                   ORDER BY 1, 2`;
    const after = (await db.query(AFTER)).rows;
    assert.deepEqual(after, before, "every roster is identical, confirmation by confirmation");
    const sums = (q: typeof before) => ({
      eligible: q.length,
      current: q.filter((r) => r.current).length,
    });
    assert.deepEqual(sums(after), sums(before), "so the KPI sums are identical");
    const shape = (
      await db.query<{ n: number; open: boolean; space: boolean; from_marker: boolean }>(
        `SELECT COUNT(*)::int AS n, bool_and(removed_at IS NULL AND exempt_at IS NULL) AS open, bool_and(source = 'space') AS space,
                bool_and(pa.cycle_started_at = d.ack_revision_at) AS from_marker
         FROM policy_assignments pa JOIN documents d ON d.id = pa.document_id`
      )
    ).rows[0];
    assert.equal(shape.n, before.length, "no row for a disabled account");
    assert.deepEqual({ open: shape.open, space: shape.space, from_marker: shape.from_marker }, { open: true, space: true, from_marker: true });
    const gone = (await db.query("SELECT id FROM users WHERE username = 'boot110_gone'")).rows[0].id;
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM policy_assignments WHERE user_id = $1", [gone])).rows[0].n, 0);
    const settings = await db.query<{ n: number; space: boolean; auto: boolean }>(
      "SELECT COUNT(*)::int AS n, bool_and(audience_mode = 'space') AS space, bool_and(assign_new_members = 1 AND exclude_stewards = 0) AS auto FROM policy_settings"
    );
    const policies = (await db.query("SELECT COUNT(*)::int AS n FROM documents WHERE ack_required = 1 OR ack_retired_at IS NOT NULL")).rows[0].n;
    assert.deepEqual(settings.rows[0], { n: policies, space: true, auto: true }, "one settings row per policy, space mode, new joiners enrolled");

    // Something a tenant does between boots that a re-run would undo: a row
    // closed by hand (the way a manager's narrowing leaves it). A second
    // boot must leave it closed: the materialisation is one-shot.
    const second = (await db.query("SELECT id FROM users WHERE username = 'boot110_second'")).rows[0].id;
    await db.query("UPDATE policy_assignments SET removed_at = now(), removed_reason = 'audience_narrowed' WHERE document_id = $1 AND user_id = $2", [quiet, second]);
    // And a rollback (invariant 12): a 1.12.0 binary running on this
    // database between the boots creates an account, switches a policy on
    // (no settings row, no rows: it knows none of the tables) and records
    // a confirmation under it. The second boot's migration is flag-guarded,
    // so the hourly sweep heals these after the re-upgrade.
    const rolledUser = (
      await db.query<{ id: number }>(
        "INSERT INTO users (username, name, email, role, status) VALUES ('boot110_rolled', 'Rolled Reader', 'rolled@boot110.test', 'viewer', 'active') RETURNING id"
      )
    ).rows[0].id;
    const rolled = (
      await db.query<{ id: number }>(
        `INSERT INTO documents (space_id, title, slug, type, status, content, author, ack_required, ack_revision_at)
         VALUES ($1, 'Boot 1.13 rolled-back policy', 'boot-113-rolled', 'policy', 'published', 'rolled text', 'boot', 1, now() - interval '1 day') RETURNING id`,
        [spaceId]
      )
    ).rows[0].id;
    await db.query("INSERT INTO doc_versions (document_id, title, content, author, note) VALUES ($1, 'Boot 1.13 rolled-back policy', 'rolled text', 'boot', 'Created')", [rolled]);
    await db.query(
      `INSERT INTO acknowledgements (document_id, user_id, acknowledged_at, ip, user_name, user_email, document_title)
       VALUES ($1, $2, now() - interval '1 hour', '10.0.0.5', 'Rolled Reader', 'rolled@boot110.test', 'Boot 1.13 rolled-back policy')`,
      [rolled, rolledUser]
    );
    const rolledLegacy = (await db.query(LEGACY)).rows.filter((r) => r.document_id === rolled);
    assert.ok(rolledLegacy.length >= 2, "1.12.0 asked everyone active in the internal space");
    assert.ok(rolledLegacy.some((r) => r.user_id === rolledUser && r.current), "and showed the rolled-back confirmation as current");
    assert.equal((await db.query("SELECT 1 FROM policy_assignments WHERE document_id = $1", [rolled])).rowCount, 0, "no row yet: 1.12.0 wrote none");
    const between = (await db.query(AFTER)).rows;
    const reboot = boot(DB);
    assert.ok(reboot.ok, `the second boot succeeds:\n${reboot.out}`);
    assert.doesNotMatch(reboot.out, /policy audiences materialised/, "the migration did not run again");
    assert.deepEqual((await db.query(AFTER)).rows, between, "nothing moved on the second boot");
    assert.equal(
      (await db.query("SELECT removed_reason FROM policy_assignments WHERE document_id = $1 AND user_id = $2", [quiet, second])).rows[0].removed_reason,
      "audience_narrowed",
      "the closed row stays closed"
    );

    // The re-upgraded binary's first hourly tick: the rolled-back policy
    // gets its settings row and its rows, each dated from the marker (the
    // policy's cycle, not the heal), so the roster 1.12.0 showed and the
    // currency of every confirmation made under it are what 1.13.0 shows.
    const healed = reconcile(DB);
    assert.ok(healed.ok, `the sweep runs:\n${healed.out}`);
    const rolledAfter = (await db.query(AFTER)).rows.filter((r) => r.document_id === rolled);
    assert.deepEqual(rolledAfter, rolledLegacy, "the rolled-back policy's roster is identical, confirmation by confirmation");
    assert.ok(rolledAfter.some((r) => r.user_id === rolledUser && r.current), "the confirmation recorded under 1.12.0 is still current");
    const healedShape = (
      await db.query<{ n: number; from_marker: boolean; open: boolean }>(
        `SELECT COUNT(*)::int AS n, bool_and(pa.cycle_started_at = d.ack_revision_at) AS from_marker, bool_and(pa.removed_at IS NULL) AS open
         FROM policy_assignments pa JOIN documents d ON d.id = pa.document_id WHERE pa.document_id = $1`,
        [rolled]
      )
    ).rows[0];
    assert.deepEqual(healedShape, { n: rolledLegacy.length, from_marker: true, open: true }, "every healed row takes the policy's cycle");
    assert.equal(
      (await db.query("SELECT audience_mode FROM policy_settings WHERE document_id = $1", [rolled])).rows[0]?.audience_mode,
      "space",
      "and the settings row is back, in space mode"
    );
    await assertSchema1101(db, "1.13.0 (D1) second boot");
  });

  test("1.14.0 (D3): policy_sets, policy_set_docs, their index and the rules' set_id come back on an upgrade boot with the contracted references, a 1.13.0-shaped rule still inserts, a set written between boots survives, and a second boot moves nothing", async () => {
    // A database shaped like 1.13.0: the two tables and the column gone (the
    // column's foreign key goes with it).
    await db.query(`
      ALTER TABLE policy_audience_rules DROP COLUMN IF EXISTS set_id;
      DROP TABLE IF EXISTS policy_set_docs;
      DROP TABLE IF EXISTS policy_sets;
    `);
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    await assertSchema1101(db, "1.14.0 (D3) upgrade boot");

    const tables = await db.query<{ t: string }>("SELECT to_regclass('policy_sets')::text AS t UNION ALL SELECT to_regclass('policy_set_docs')::text");
    assert.deepEqual(tables.rows.map((r) => r.t), ["policy_sets", "policy_set_docs"], "both tables exist");
    const shape = async () =>
      (
        await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
          `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND (table_name IN ('policy_sets', 'policy_set_docs') OR (table_name = 'policy_audience_rules' AND column_name = 'set_id'))
           ORDER BY table_name, column_name`
        )
      ).rows;
    const expected = [
      { table_name: "policy_audience_rules", column_name: "set_id", data_type: "integer", is_nullable: "YES", column_default: null },
      { table_name: "policy_set_docs", column_name: "document_id", data_type: "integer", is_nullable: "NO", column_default: null },
      { table_name: "policy_set_docs", column_name: "position", data_type: "integer", is_nullable: "NO", column_default: "0" },
      { table_name: "policy_set_docs", column_name: "set_id", data_type: "integer", is_nullable: "NO", column_default: null },
      { table_name: "policy_sets", column_name: "active", data_type: "integer", is_nullable: "NO", column_default: "1" },
      { table_name: "policy_sets", column_name: "assign_new_members", data_type: "integer", is_nullable: "NO", column_default: "1" },
      { table_name: "policy_sets", column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
      { table_name: "policy_sets", column_name: "created_by", data_type: "integer", is_nullable: "YES", column_default: null },
      { table_name: "policy_sets", column_name: "deactivated_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      { table_name: "policy_sets", column_name: "description", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      { table_name: "policy_sets", column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null },
      { table_name: "policy_sets", column_name: "name", data_type: "text", is_nullable: "NO", column_default: null },
    ];
    assert.deepEqual(await shape(), expected, "the columns with their defaults (metadata-only: constant defaults, no backfill)");
    const pk = await db.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'policy_set_docs'::regclass AND contype = 'p'");
    assert.deepEqual(pk.rows.map((r) => r.def), ["PRIMARY KEY (set_id, document_id)"], "one position per policy and set");
    const fks = async () =>
      (
        await db.query<{ t: string; conname: string; confdeltype: string }>(
          `SELECT conrelid::regclass::text AS t, conname, confdeltype FROM pg_constraint
           WHERE contype = 'f' AND (conrelid IN ('policy_sets'::regclass, 'policy_set_docs'::regclass)
                                    OR (conrelid = 'policy_audience_rules'::regclass AND conname = 'policy_audience_rules_set_id_fkey'))
           ORDER BY 1, 2`
        )
      ).rows.map((r) => [r.t, r.conname, r.confdeltype]);
    const expectedFks = [
      ["policy_audience_rules", "policy_audience_rules_set_id_fkey", "n"],
      ["policy_set_docs", "policy_set_docs_document_id_fkey", "c"],
      ["policy_set_docs", "policy_set_docs_set_id_fkey", "c"],
      ["policy_sets", "policy_sets_created_by_fkey", "n"],
    ];
    assert.deepEqual(await fks(), expectedFks, "a deleted set untags its rules and loses its members; a purged document leaves the set; a deleted creator reads as nobody");
    const index = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_policy_set_docs_doc'"
    );
    assert.equal(index.rows.length, 1, "idx_policy_set_docs_doc exists");
    assert.match(index.rows[0].indexdef, /USING btree \(document_id\)/);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM policy_sets")).rows[0].n, 0, "the upgrade creates no set");

    // A 1.13.0-shaped rule insert (what a rolled-back binary writes: no
    // set_id) still works and reads as a manager's rule.
    const policy = (await db.query<{ id: number }>("SELECT id FROM documents WHERE ack_required = 1 ORDER BY id LIMIT 1")).rows[0].id;
    const legacy = await db.query<{ id: number; set_id: number | null }>(
      "INSERT INTO policy_audience_rules (document_id, kind, ref, effect) VALUES ($1, 'role', 'viewer', 'include') RETURNING id, set_id",
      [policy]
    );
    assert.equal(legacy.rows[0].set_id, null);

    // A set written between boots (what createPolicySet and assignPolicySet
    // write, done by hand so the boot is the only code under test) survives
    // the next one untouched, members, tag and all.
    const setId = (
      await db.query<{ id: number }>(
        "INSERT INTO policy_sets (name, description, assign_new_members) VALUES ('Boot onboarding', 'Day one', 1) RETURNING id"
      )
    ).rows[0].id;
    await db.query("INSERT INTO policy_set_docs (set_id, document_id, position) VALUES ($1, $2, 0)", [setId, policy]);
    await db.query("UPDATE policy_audience_rules SET set_id = $2 WHERE id = $1", [legacy.rows[0].id, setId]);
    const second = boot(DB);
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.deepEqual(await shape(), expected, "the second boot leaves the shape alone");
    assert.deepEqual(await fks(), expectedFks, "the references are still there");
    const kept = await db.query<{ name: string; active: number; assign_new_members: number; members: number; tagged: number }>(
      `SELECT p.name, p.active, p.assign_new_members,
              (SELECT COUNT(*)::int FROM policy_set_docs sd WHERE sd.set_id = p.id) AS members,
              (SELECT COUNT(*)::int FROM policy_audience_rules r WHERE r.set_id = p.id) AS tagged
       FROM policy_sets p WHERE p.id = $1`,
      [setId]
    );
    assert.deepEqual(kept.rows[0], { name: "Boot onboarding", active: 1, assign_new_members: 1, members: 1, tagged: 1 }, "the set is as written");
    // Deleting the set: the members go with it, the rule stays untagged (the contracted ON DELETE rules at work).
    await db.query("DELETE FROM policy_sets WHERE id = $1", [setId]);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM policy_set_docs WHERE set_id = $1", [setId])).rows[0].n, 0);
    assert.deepEqual(
      (await db.query("SELECT set_id FROM policy_audience_rules WHERE id = $1", [legacy.rows[0].id])).rows,
      [{ set_id: null }],
      "the rule keeps its id, untagged"
    );
    await db.query("DELETE FROM policy_audience_rules WHERE id = $1", [legacy.rows[0].id]);
    await assertSchema1101(db, "1.14.0 (D3) second boot");
  });

  test("1.14.0 (F2): compliance_snapshots, its monthly unique index and the two reference indexes come back on an upgrade boot in the contracted shape, a month is claimed once, a snapshot written between boots survives, and a second boot moves nothing", async () => {
    // A database shaped like 1.13.0: the table (and so its indexes) gone.
    await db.query("DROP TABLE IF EXISTS compliance_snapshots");
    const upgrade = boot(DB);
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);

    const shape = async () =>
      (
        await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_identity: string }>(
          `SELECT column_name, data_type, is_nullable, column_default, is_identity FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'compliance_snapshots' ORDER BY ordinal_position`
        )
      ).rows;
    const expected = [
      { column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null, is_identity: "YES" },
      { column_name: "taken_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()", is_identity: "NO" },
      { column_name: "kind", data_type: "text", is_nullable: "NO", column_default: "'manual'::text", is_identity: "NO" },
      { column_name: "period", data_type: "text", is_nullable: "NO", column_default: "''::text", is_identity: "NO" },
      { column_name: "document_id", data_type: "integer", is_nullable: "YES", column_default: null, is_identity: "NO" },
      { column_name: "taken_by", data_type: "integer", is_nullable: "YES", column_default: null, is_identity: "NO" },
      { column_name: "taken_by_name", data_type: "text", is_nullable: "NO", column_default: "'system'::text", is_identity: "NO" },
      { column_name: "sha256", data_type: "text", is_nullable: "NO", column_default: null, is_identity: "NO" },
      { column_name: "data", data_type: "text", is_nullable: "NO", column_default: null, is_identity: "NO" },
    ];
    assert.deepEqual(await shape(), expected, "the contracted columns, types and defaults (metadata-only)");
    const indexes = async () =>
      (
        await db.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'compliance_snapshots' ORDER BY indexname`
        )
      ).rows;
    const idx = await indexes();
    assert.deepEqual(
      idx.map((i) => i.indexname),
      ["compliance_snapshots_pkey", "idx_compliance_snapshots_doc", "idx_compliance_snapshots_monthly", "idx_compliance_snapshots_taken_by"],
      "the primary key, the monthly claim and the two reference indexes"
    );
    assert.match(
      idx.find((i) => i.indexname === "idx_compliance_snapshots_monthly")!.indexdef,
      /CREATE UNIQUE INDEX idx_compliance_snapshots_monthly ON (public\.)?compliance_snapshots USING btree \(period\) WHERE \(kind = 'monthly'::text\)/
    );
    assert.match(idx.find((i) => i.indexname === "idx_compliance_snapshots_doc")!.indexdef, /\(document_id\) WHERE \(document_id IS NOT NULL\)/);
    assert.match(idx.find((i) => i.indexname === "idx_compliance_snapshots_taken_by")!.indexdef, /\(taken_by\) WHERE \(taken_by IS NOT NULL\)/);
    const fks = await db.query<{ confrelid: string; confdeltype: string }>(
      `SELECT confrelid::regclass::text AS confrelid, confdeltype FROM pg_constraint
       WHERE conrelid = 'compliance_snapshots'::regclass AND contype = 'f' ORDER BY confrelid::regclass::text`
    );
    assert.deepEqual(
      fks.rows,
      [
        { confrelid: "documents", confdeltype: "n" },
        { confrelid: "users", confdeltype: "n" },
      ],
      "both references SET NULL, so a purge or an account deletion never takes evidence with it"
    );
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM compliance_snapshots")).rows[0].n, 0, "nothing is backfilled");

    // The monthly claim: the second INSERT for a period finds it taken; a
    // manual snapshot of the same period is not a claim.
    const first = await db.query<{ id: number }>(
      `INSERT INTO compliance_snapshots (kind, period, sha256, data) VALUES ('monthly', '2026-01', 'a', '{}')
       ON CONFLICT (period) WHERE kind = 'monthly' DO NOTHING RETURNING id`
    );
    assert.equal(first.rowCount, 1, "the first claim wins");
    const second = await db.query(
      `INSERT INTO compliance_snapshots (kind, period, sha256, data) VALUES ('monthly', '2026-01', 'b', '{}')
       ON CONFLICT (period) WHERE kind = 'monthly' DO NOTHING RETURNING id`
    );
    assert.equal(second.rowCount, 0, "the second finds the month taken");
    const manual = await db.query<{ id: number; taken_by_name: string; kind: string }>(
      "INSERT INTO compliance_snapshots (kind, period, sha256, data) VALUES ('manual', '2026-01', 'c', '{}') RETURNING id, taken_by_name, kind"
    );
    assert.deepEqual(manual.rows[0], { id: manual.rows[0].id, taken_by_name: "system", kind: "manual" }, "a manual one takes the defaults");

    const reboot = boot(DB);
    assert.ok(reboot.ok, `the second boot succeeds:\n${reboot.out}`);
    assert.deepEqual(await shape(), expected, "the second boot leaves the shape alone");
    assert.deepEqual((await indexes()).map((i) => i.indexname), idx.map((i) => i.indexname));
    assert.deepEqual(
      (await db.query<{ id: number; sha256: string }>("SELECT id, sha256 FROM compliance_snapshots ORDER BY id")).rows,
      [
        { id: first.rows[0].id, sha256: "a" },
        { id: manual.rows[0].id, sha256: "c" },
      ],
      "the rows written between boots survive, untouched"
    );
    await db.query("DELETE FROM compliance_snapshots");
    await assertSchema1101(db, "1.14.0 (F2) second boot");
  });
});

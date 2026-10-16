// The 1.10.0 confirmation-marker upgrade against a database shaped like
// 1.9.4, booted twice (A1/C5 double-boot idempotency).
//
// The trap this pins: the marker must be backfilled from updated_at so that
// every confirmation 1.9.x showed as current is still current after the
// upgrade, and the one-shot helpers (version inference, the FK swap) must
// run exactly once — a second boot must move nothing. Keep this test in CI
// for every later release that touches SCHEMA_SQL or initialize().
//
// Boots run in a child process (the init promise is cached per process) in a
// database of this file's own, shaped by hand: a fresh 1.10 boot, then the
// 1.10 additions are stripped back to the 1.9.4 shape before the fixtures go
// in and the upgrade boot runs.
//
// Run: npm run test:integration  (needs DATABASE_URL with CREATE DATABASE)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";

const BASE = process.env.DATABASE_URL ?? "";
const DB = `compass_ackboot_${process.pid}`;

function urlFor(db: string): string {
  const u = new URL(BASE);
  u.pathname = `/${db}`;
  return u.toString();
}

function boot(): { ok: boolean; out: string } {
  const r = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.test.json", "test/support/boot.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: urlFor(DB),
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

// Strip the 1.10.0 additions so the database looks the way 1.9.4 left it.
const DOWNGRADE_SQL = `
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
  DROP TABLE IF EXISTS ack_notices;
  DROP TABLE IF EXISTS ack_outbox;
  ALTER TABLE doc_versions
    DROP COLUMN IF EXISTS published_by, DROP COLUMN IF EXISTS published_by_name,
    DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_by_name,
    DROP COLUMN IF EXISTS change_request_id;
  DELETE FROM settings WHERE key IN
    ('migrated_ack_revisions', 'ack_marker_schema', 'migrated_ack_retention', 'ack_retention_schema',
     'migrated_version_provenance');
`;

interface Snapshot {
  docs: { id: number; updated_at: string; ack_revision_at: string; ack_version_id: number | null }[];
  acks: { id: number; version_id: number | null; content_sha256: string | null; user_name: string; current: boolean }[];
  flags: string[];
}

async function snapshot(db: Client, docIds: number[]): Promise<Snapshot> {
  const docs = await db.query(
    "SELECT id, updated_at::text, ack_revision_at::text, ack_version_id FROM documents WHERE id = ANY($1) ORDER BY id",
    [docIds]
  );
  const acks = await db.query(
    `SELECT a.id, a.version_id, a.content_sha256, a.user_name,
            (a.acknowledged_at >= d.ack_revision_at) AS current
     FROM acknowledgements a JOIN documents d ON d.id = a.document_id
     WHERE a.document_id = ANY($1) ORDER BY a.id`,
    [docIds]
  );
  const flags = await db.query(
    "SELECT key || '=' || value AS kv FROM settings WHERE key IN ('migrated_ack_revisions','ack_marker_schema','migrated_ack_retention','ack_retention_schema') ORDER BY key"
  );
  return { docs: docs.rows, acks: acks.rows, flags: flags.rows.map((r) => r.kv) };
}

describe("confirmation marker upgrade (1.9.4 → 1.10.0), booted twice", () => {
  let db: Client;

  before(async () => {
    assert.ok(BASE, "DATABASE_URL is set");
    await withAdmin((c) => c.query(`CREATE DATABASE ${DB}`));
    const first = boot();
    assert.ok(first.ok, `fresh boot succeeds:\n${first.out}`);
    db = new Client({ connectionString: urlFor(DB) });
    await db.connect();
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

    const upgrade = boot();
    assert.ok(upgrade.ok, `the upgrade boot succeeds:\n${upgrade.out}`);
    assert.match(upgrade.out, /\[ack\] stamped the confirmation marker/, "the version backfill ran and logged its counts");
    assert.match(upgrade.out, /\[ack\] attestation records now outlive/, "the retention migration ran");

    const once = await snapshot(db, [policy, quiet]);
    for (const d of once.docs) {
      assert.equal(d.ack_revision_at, d.updated_at, `document ${d.id}: the marker is the old updated_at, not upgrade time`);
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
    assert.deepEqual(once.flags, [
      "ack_marker_schema=1",
      "ack_retention_schema=1",
      "migrated_ack_retention=1",
      "migrated_ack_revisions=1",
    ]);
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
    // confirmation whose inferred version was cleared. A second boot must
    // leave it alone (the inference is one-shot). And something a re-run
    // must catch: a document created while the workspace was rolled back to
    // 1.9.x arrives without a marker version (1.9.x's createDocument writes
    // none) and gets one on the next boot.
    await db.query("UPDATE acknowledgements SET version_id = NULL WHERE user_id = $1", [early]);
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

    const second = boot();
    assert.ok(second.ok, `the second boot succeeds:\n${second.out}`);
    assert.doesNotMatch(second.out, /inferred the version/, "the confirmation inference did not run again");
    assert.doesNotMatch(second.out, /attestation records now outlive/, "the retention migration did not run again");
    assert.match(second.out, /\[ack\] stamped the confirmation marker on 1 document\(s\) created without one/);
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
});

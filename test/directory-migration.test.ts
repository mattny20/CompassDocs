// The 1.2 registry migration against a database shaped like 1.1: a
// Graph-mapped field whose values the old sync wrote into `custom`, and an
// assistant_id link. 1.2.0's synced_v1 step failed on exactly this shape
// ("column k does not exist") and, because the steps before it had already
// been recorded as done, every restart failed the same way — the release
// verification database had no mapped field, so the statement never ran.
//
// Boots run in a child process (the init promise is cached per process) and
// in a database of this file's own: the other files share DATABASE_URL, run
// concurrently, and keep manual overrides on synced rows that a re-run of the
// migration would fold away underneath them.
//
// Run: npm run test:integration  (needs DATABASE_URL with CREATE DATABASE)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";

const BASE = process.env.DATABASE_URL ?? "";
const DB = `compass_migration_${process.pid}`;

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
        COMPASSDOCS_ADMIN_USER: process.env.COMPASSDOCS_ADMIN_USER || "migration_admin",
        COMPASSDOCS_ADMIN_PASSWORD: process.env.COMPASSDOCS_ADMIN_PASSWORD || "Migration!12345",
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

describe("directory registry migration (1.1 → 1.2)", () => {
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

  test("a mapped field's values move out of the manual layer, links fold in, and the boot resumes", async () => {
    // Shape the database the way 1.1 left it: the sync wrote mapped values
    // into custom, the assistant was a single column, no migration recorded.
    await db.query(
      `INSERT INTO directory_fields (key, label, graph_path) VALUES ('mig_practice', 'Practice group', 'onPremisesExtensionAttributes.extensionAttribute1')`
    );
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO directory_people (source, external_id, name, email, custom) VALUES
         ('graph',  'mig-1', 'Mig Attorney',  'mig-1@migration.example', '{"mig_practice":"Litigation","mig_note":"typed by hand"}'),
         ('graph',  'mig-2', 'Mig Assistant', 'mig-2@migration.example', '{"mig_practice":"Litigation"}'),
         ('manual', NULL,    'Mig Walk-in',   'mig-3@migration.example', '{"mig_practice":"Typed"}')
       RETURNING id`
    );
    const [attorney, assistant, walkIn] = rows.map((r) => r.id);
    await db.query("UPDATE directory_people SET assistant_id = $2 WHERE id = $1", [attorney, assistant]);
    await db.query("UPDATE settings SET value = '[]' WHERE key = 'directory_migrations'");

    const second = boot();
    assert.ok(second.ok, `boot against the 1.1-shaped data succeeds:\n${second.out}`);

    const people = await db.query<{ id: number; custom: Record<string, string>; synced: Record<string, string> }>(
      "SELECT id, custom, synced FROM directory_people WHERE id = ANY($1::int[]) ORDER BY id",
      [[attorney, assistant, walkIn]]
    );
    const byId = new Map(people.rows.map((r) => [r.id, r]));
    assert.deepEqual(byId.get(attorney)!.synced, { mig_practice: "Litigation" }, "the mapped value is now synced");
    assert.deepEqual(byId.get(attorney)!.custom, { mig_note: "typed by hand" }, "an unmapped key stays manual");
    assert.deepEqual(byId.get(assistant)!.synced, { mig_practice: "Litigation" });
    assert.deepEqual(byId.get(walkIn)!.custom, { mig_practice: "Typed" }, "a manual row's values are its own");
    assert.deepEqual(byId.get(walkIn)!.synced, {});

    const links = await db.query("SELECT person_id, field_key, target_id, source FROM directory_person_links WHERE person_id = $1", [attorney]);
    assert.deepEqual(links.rows, [{ person_id: attorney, field_key: "assistant", target_id: assistant, source: "manual" }]);

    const marker = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'directory_migrations'");
    assert.deepEqual(JSON.parse(marker.rows[0].value).sort(), ["links_v1", "synced_v1", "tag_highlight_v1"]);

    // A third boot is a no-op: recorded steps do not run again, so a value
    // an admin later moves or deletes is not resurrected.
    await db.query("UPDATE directory_people SET synced = '{}'::jsonb WHERE id = $1", [assistant]);
    const third = boot();
    assert.ok(third.ok, `boot on a migrated database succeeds:\n${third.out}`);
    const again = await db.query<{ synced: Record<string, string> }>("SELECT synced FROM directory_people WHERE id = $1", [assistant]);
    assert.deepEqual(again.rows[0].synced, {}, "synced_v1 did not run a second time");
  });
});

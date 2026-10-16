// guardAddColumns (1.10.1): every every-boot `ADD COLUMN IF NOT EXISTS` in
// SCHEMA_SQL becomes a catalog lookup first, so a later boot takes no lock on
// a table whose columns already exist. Pure string test; the double-boot
// check in test/ack-boot.test.ts runs the rewritten schema against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { guardAddColumns } from "../src/lib/db";

test("rewrites a one-line add into a guarded block with the same definition", () => {
  const out = guardAddColumns(`  ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'system';\n`);
  assert.equal(
    out.trim(),
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'theme') THEN ALTER TABLE users ADD COLUMN theme text NOT NULL DEFAULT 'system'; END IF; END $$;"
  );
});

test("handles a definition that wraps onto the next line and keeps references and casts", () => {
  const out = guardAddColumns(
    `ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS\n    scopes jsonb NOT NULL DEFAULT '["read","write"]'::jsonb;\n` +
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS\n    directory_person_id integer REFERENCES directory_people(id) ON DELETE SET NULL;`
  );
  assert.match(out, /column_name = 'scopes'\) THEN ALTER TABLE api_tokens ADD COLUMN scopes jsonb NOT NULL DEFAULT '\["read","write"\]'::jsonb; END IF;/);
  assert.match(out, /column_name = 'directory_person_id'\) THEN ALTER TABLE users ADD COLUMN directory_person_id integer REFERENCES directory_people\(id\) ON DELETE SET NULL; END IF;/);
  assert.equal((out.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 0);
});

test("leaves everything else alone", () => {
  const sql = `CREATE TABLE IF NOT EXISTS t (id int);\nDO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN ALTER TABLE t ADD COLUMN c int; END IF; END $$;\nCREATE INDEX IF NOT EXISTS i ON t(id);`;
  assert.equal(guardAddColumns(sql), sql);
});

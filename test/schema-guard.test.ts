// guardAddColumns and guardCreateIndexes (1.10.1): every every-boot `ADD
// COLUMN IF NOT EXISTS` and `CREATE [UNIQUE] INDEX IF NOT EXISTS` in
// SCHEMA_SQL becomes a catalog lookup first, so a later boot takes no lock
// on a table whose columns and indexes already exist. Pure string tests,
// plus one that reads the real SCHEMA_SQL out of src/lib/db.ts and proves
// nothing is left unguarded; the double-boot check in test/ack-boot.test.ts
// runs the rewritten schema against Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { guardAddColumns, guardCreateIndexes } from "../src/lib/db";

const COLUMN_PREDICATE = (table: string, column: string) =>
  `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('${table}') AND attname = '${column}' AND attnum > 0 AND NOT attisdropped`;

/** The schema template literal as the running code sees it, read from the source. */
function realSchemaSql(): string {
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "db.ts"), "utf8");
  const start = src.indexOf("const SCHEMA_SQL = `");
  assert.ok(start >= 0, "SCHEMA_SQL is declared in src/lib/db.ts");
  const open = src.indexOf("`", start) + 1;
  const close = src.indexOf("\n`;", open);
  assert.ok(close > open, "the template literal closes");
  return src.slice(open, close);
}

/** Lines of SQL that are not `--` comments. */
function codeLines(sql: string): string[] {
  return sql.split("\n").filter((l) => !l.trim().startsWith("--"));
}

test("rewrites a one-line add into a guarded block with the same definition", () => {
  const out = guardAddColumns(`  ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'system';\n`);
  assert.equal(
    out.trim(),
    `DO $$ BEGIN IF NOT EXISTS (${COLUMN_PREDICATE("users", "theme")}) THEN ALTER TABLE users ADD COLUMN theme text NOT NULL DEFAULT 'system'; END IF; END $$;`
  );
});

test("handles a definition that wraps onto the next line and keeps references and casts", () => {
  const out = guardAddColumns(
    `ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS\n    scopes jsonb NOT NULL DEFAULT '["read","write"]'::jsonb;\n` +
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS\n    directory_person_id integer REFERENCES directory_people(id) ON DELETE SET NULL;`
  );
  assert.match(out, /attname = 'scopes' AND attnum > 0 AND NOT attisdropped\) THEN ALTER TABLE api_tokens ADD COLUMN scopes jsonb NOT NULL DEFAULT '\["read","write"\]'::jsonb; END IF;/);
  assert.match(out, /attname = 'directory_person_id' AND attnum > 0 AND NOT attisdropped\) THEN ALTER TABLE users ADD COLUMN directory_person_id integer REFERENCES directory_people\(id\) ON DELETE SET NULL; END IF;/);
  assert.equal((out.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 0);
});

test("handles a line break between the table name and ADD (the directory_people pair)", () => {
  const out = guardAddColumns(
    `  ALTER TABLE directory_people\n    ADD COLUMN IF NOT EXISTS assistant_id integer REFERENCES directory_people(id) ON DELETE SET NULL;\n` +
      `  ALTER TABLE directory_people\n    ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb;\n`
  );
  assert.equal((out.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 0, "both are rewritten");
  assert.match(out, /to_regclass\('directory_people'\) AND attname = 'assistant_id'[^;]*\) THEN ALTER TABLE directory_people ADD COLUMN assistant_id integer REFERENCES directory_people\(id\) ON DELETE SET NULL; END IF;/);
  assert.match(out, /to_regclass\('directory_people'\) AND attname = 'custom'[^;]*\) THEN ALTER TABLE directory_people ADD COLUMN custom jsonb NOT NULL DEFAULT '\{\}'::jsonb; END IF;/);
});

test("leaves everything else alone", () => {
  const sql = `CREATE TABLE IF NOT EXISTS t (id int);\nDO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN ALTER TABLE t ADD COLUMN c int; END IF; END $$;\nDO $$ BEGIN IF to_regclass('i') IS NULL THEN CREATE INDEX i ON t(id); END IF; END $$;`;
  assert.equal(guardAddColumns(sql), sql);
  assert.equal(guardCreateIndexes(sql), sql);
});

test("rewrites a one-line CREATE INDEX IF NOT EXISTS into a to_regclass block", () => {
  const out = guardCreateIndexes(`  CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);\n`);
  assert.equal(
    out.trim(),
    "DO $$ BEGIN IF to_regclass('idx_documents_space') IS NULL THEN CREATE INDEX idx_documents_space ON documents(space_id); END IF; END $$;"
  );
});

test("keeps UNIQUE, a definition that spans lines, USING gin(...) and a WHERE predicate", () => {
  const out = guardCreateIndexes(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ra_user_space\n    ON role_assignments (user_id, role_id, space_id) WHERE user_id IS NOT NULL AND scope_type = 'space';\n` +
      `CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING gin(search);\n` +
      `CREATE INDEX IF NOT EXISTS idx_directory_name_lower\n    ON directory_people(lower(name) text_pattern_ops);\n` +
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_training_snapshots_monthly\n    ON training_snapshots(period) WHERE kind = 'monthly';`
  );
  assert.equal((out.match(/INDEX IF NOT EXISTS/g) ?? []).length, 0);
  assert.match(
    out,
    /IF to_regclass\('idx_ra_user_space'\) IS NULL THEN CREATE UNIQUE INDEX idx_ra_user_space ON role_assignments \(user_id, role_id, space_id\) WHERE user_id IS NOT NULL AND scope_type = 'space'; END IF;/
  );
  assert.match(out, /IF to_regclass\('idx_documents_search'\) IS NULL THEN CREATE INDEX idx_documents_search ON documents USING gin\(search\); END IF;/);
  assert.match(out, /THEN CREATE INDEX idx_directory_name_lower ON directory_people\(lower\(name\) text_pattern_ops\); END IF;/);
  assert.match(out, /THEN CREATE UNIQUE INDEX idx_training_snapshots_monthly ON training_snapshots\(period\) WHERE kind = 'monthly'; END IF;/);
  assert.equal((out.match(/DO \$\$ BEGIN/g) ?? []).length, 4, "one block per statement");
});

test("the real schema: no ADD COLUMN IF NOT EXISTS or CREATE INDEX IF NOT EXISTS survives outside a comment", () => {
  const schema = realSchemaSql();
  const before = codeLines(schema).join("\n");
  const adds = (before.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length;
  const indexes = (before.match(/INDEX IF NOT EXISTS/g) ?? []).length;
  assert.ok(adds > 90, `the schema carries the ADD COLUMN statements the guard exists for (${adds})`);
  assert.ok(indexes > 40, `and the CREATE INDEX statements (${indexes})`);

  const after = codeLines(guardCreateIndexes(guardAddColumns(schema))).join("\n");
  assert.equal((after.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 0, "every ADD COLUMN is guarded");
  assert.equal((after.match(/INDEX IF NOT EXISTS/g) ?? []).length, 0, "every CREATE INDEX is guarded");
  assert.equal((after.match(/THEN ALTER TABLE \w+ ADD COLUMN /g) ?? []).length, adds, "one block per ADD COLUMN");
  assert.equal((after.match(/THEN CREATE (UNIQUE )?INDEX \w+ ON /g) ?? []).length, indexes, "one block per CREATE INDEX");
  // No guarded block swallowed a comment or a neighbour: every generated
  // block is one line that ends where it should.
  for (const line of after.split("\n")) {
    if (!line.includes("END IF; END $$;")) continue;
    if (!/^DO \$\$ BEGIN IF /.test(line.trim())) continue;
    assert.ok(!line.includes("--"), `no comment inside a generated block: ${line.slice(0, 120)}`);
    assert.equal((line.match(/DO \$\$ BEGIN/g) ?? []).length, 1, `one block per line: ${line.slice(0, 120)}`);
  }
  // The statements the old guard missed (a line break before ADD) and the
  // every-boot statements closed in 1.10.1 are not in the output as bare DDL.
  assert.doesNotMatch(after, /ALTER TABLE directory_people\s+ADD COLUMN IF NOT EXISTS/);
  assert.doesNotMatch(after, /^\s*DROP TRIGGER IF EXISTS compass_users_ladder_sync/m, "the users trigger is guarded");
  assert.doesNotMatch(after, /^\s*ALTER TABLE spaces ALTER COLUMN visibility SET DEFAULT/m, "the spaces default is guarded");
  assert.doesNotMatch(
    after,
    /^\s*ALTER TABLE training_completion_history ALTER COLUMN \w+ DROP NOT NULL/m,
    "the history DROP NOT NULL pair is guarded"
  );
  assert.doesNotMatch(after, /^\s*ALTER TABLE training_completion_history\s+DROP CONSTRAINT/m, "the history FK swap is guarded");
});

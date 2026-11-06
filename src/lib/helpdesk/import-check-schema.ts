// Helpdesk 1.19.2: the import's dry run and map-step rescan as background
// jobs (agent W5, lib/helpdesk/import-check). Dependency-free so lib/db.ts
// can interpolate it into SCHEMA_SQL. Additive, one ALTER per column
// (test/schema-guard), no backfill: a 1.19.1 binary ignores them.
//
// While a check runs the job's status is 'checking' and heartbeat_at is the
// check's lease, as it is the import run's (the two never overlap).
//
//   check_kind      'dry_run' or 'rescan' (the last check asked for).
//   check_progress  rows checked, the total, counts so far and when it
//                   started (the page's progress bar and time left).
//   check_by        who asked (their bell hears when it is ready).
//   check_error     why the last check stopped, shown on the map step.
export const HD_IMPORT_CHECK_SCHEMA = `
  ALTER TABLE hd_import_jobs ADD COLUMN IF NOT EXISTS check_kind text NOT NULL DEFAULT '';
  ALTER TABLE hd_import_jobs ADD COLUMN IF NOT EXISTS check_progress jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE hd_import_jobs ADD COLUMN IF NOT EXISTS check_by integer REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE hd_import_jobs ADD COLUMN IF NOT EXISTS check_error text NOT NULL DEFAULT '';
`;

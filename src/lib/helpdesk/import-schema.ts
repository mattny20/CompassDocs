// Helpdesk 1.19.1: ticket import (Zoho Desk export or CSV, lib/helpdesk/import).
// Dependency-free so lib/db.ts can interpolate it into SCHEMA_SQL.
//
// hd_import_jobs: one row per upload. status walks uploaded → ready (after
// a dry run) → queued → running → completed, or cancelling → cancelled,
// failed, discarded. files names the stored uploads (deleted when the job
// completes, or after 7 days); mapping is what the admin chose; counts
// holds the scan, the dry run and the run's own counts; progress is the
// resumable cursor (phase and rows done).
//
// hd_tickets.import_source + import_ref keep the source system's ticket id
// so a re-run updates instead of duplicating; hd_messages.import_ref does
// the same for each conversation entry within its ticket.
export const HD_IMPORT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hd_import_jobs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_by_name text NOT NULL DEFAULT '',
    source text NOT NULL,
    status text NOT NULL DEFAULT 'uploaded',
    filename text NOT NULL DEFAULT '',
    files jsonb NOT NULL DEFAULT '{}',
    counts jsonb NOT NULL DEFAULT '{}',
    mapping jsonb NOT NULL DEFAULT '{}',
    progress jsonb NOT NULL DEFAULT '{}',
    error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz,
    finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_hd_import_jobs_status ON hd_import_jobs(status, updated_at);
  ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS import_source text;
  ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS import_ref text;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_tickets_import ON hd_tickets(import_source, import_ref) WHERE import_ref IS NOT NULL;
  ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS import_ref text;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_messages_import ON hd_messages(ticket_id, import_ref) WHERE import_ref IS NOT NULL;
`;

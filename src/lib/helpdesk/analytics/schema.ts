// Helpdesk 1.19.0 reports (agent K): the dashboards and report schedules
// tables, plus the indexes the report queries lean on. Kept apart from the
// server code so lib/db's SCHEMA string can append it without importing
// anything (the Helpdesk block's one-line hook: `${HD_ANALYTICS_SCHEMA}`
// after the hd_* tables it references). Additive and idempotent, constant
// defaults, like the rest of the block.
//
//   hd_dashboards          a saved dashboard: layout = HdDashboardLayout
//                          (lib/helpdesk/analytics/shared). builtin names a
//                          read-only template the reports seed and keep in
//                          step with the code ("overview", "sla", …).
//   hd_report_schedules    deliver a dashboard's summary by email on a
//                          cadence; recipients = {users:[ids], teams:[ids]},
//                          each recipient sees only their own scope.
//
// Until the hook is in lib/db, lib/helpdesk/analytics/store runs this once
// per process under an advisory lock (ensureAnalyticsSchema).

export const HD_ANALYTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_dashboards (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id integer REFERENCES users(id) ON DELETE SET NULL,
  visibility text NOT NULL DEFAULT 'private',
  team_id integer REFERENCES hd_teams(id) ON DELETE SET NULL,
  layout jsonb NOT NULL DEFAULT '{"widgets":[]}',
  is_default integer NOT NULL DEFAULT 0,
  builtin text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_dashboards_builtin ON hd_dashboards(builtin) WHERE builtin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_dashboards_owner ON hd_dashboards(owner_id);
CREATE TABLE IF NOT EXISTS hd_report_schedules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dashboard_id integer NOT NULL REFERENCES hd_dashboards(id) ON DELETE CASCADE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  recipients jsonb NOT NULL DEFAULT '{"users":[],"teams":[]}',
  frequency text NOT NULL DEFAULT 'weekly',
  weekday integer NOT NULL DEFAULT 1,
  hour integer NOT NULL DEFAULT 8,
  format text NOT NULL DEFAULT 'email',
  last_sent_at timestamptz,
  enabled integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_report_schedules_dashboard ON hd_report_schedules(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_hd_report_schedules_enabled ON hd_report_schedules(enabled) WHERE enabled = 1;
${"" /* Report indexes on the core tables (proposed to agent A; idempotent here too). */}
CREATE INDEX IF NOT EXISTS idx_hd_tickets_created ON hd_tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_hd_tickets_solved ON hd_tickets(solved_at) WHERE solved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_csat ON hd_tickets(csat_at) WHERE csat_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_team_created ON hd_tickets(team_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hd_tickets_frd ON hd_tickets(first_reply_due) WHERE first_reply_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_rsd ON hd_tickets(resolve_due) WHERE resolve_due IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_messages_status_change ON hd_messages(created_at) WHERE kind = 'system' AND via = 'system';
`;

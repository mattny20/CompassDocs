// Helpdesk 1.19.0: machine intake's schema (agent P, lib/helpdesk/intake).
// Kept apart from the server code so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent, like the rest of the
// Helpdesk block; it must come after hd_teams and hd_tickets.
//
//   hd_integrations       one per monitoring tool, bot or automated mail
//                         sender: its API key (sha256 only, shown once),
//                         where its tickets go and how alerts dedupe.
//   hd_alert_keys         an alert's dedup key -> the ticket it opened, how
//                         often it fired and whether it is firing now.
//   hd_intake_deliveries  each POST (or matched email) and what came of it,
//                         for the integration's deliveries log.
//   hd_intake_requests    the retry guard: a request id, or a payload hash
//                         per minute, seen once per integration.
//   hd_tickets            automated (1 = no person behind it) and the
//                         integration that opened it.

export const HD_INTAKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_integrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  token_hash text NOT NULL DEFAULT '',
  token_prefix text NOT NULL DEFAULT '',
  sender_addresses jsonb NOT NULL DEFAULT '[]',
  subject_dedup_pattern text NOT NULL DEFAULT '',
  default_team_id integer REFERENCES hd_teams(id) ON DELETE SET NULL,
  default_priority text NOT NULL DEFAULT 'normal',
  severity_map jsonb NOT NULL DEFAULT '{}',
  dedup_window_minutes integer NOT NULL DEFAULT 1440,
  auto_resolve integer NOT NULL DEFAULT 1,
  reopen_on_repeat integer NOT NULL DEFAULT 1,
  rate_limit_per_minute integer NOT NULL DEFAULT 60,
  enabled integer NOT NULL DEFAULT 1,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS hd_alert_keys (
  integration_id integer NOT NULL REFERENCES hd_integrations(id) ON DELETE CASCADE,
  dedup_key text NOT NULL,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'firing',
  severity text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  links jsonb NOT NULL DEFAULT '[]',
  fields jsonb NOT NULL DEFAULT '{}',
  resolved_at timestamptz,
  PRIMARY KEY (integration_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_hd_alert_keys_ticket ON hd_alert_keys(ticket_id);
CREATE INDEX IF NOT EXISTS idx_hd_alert_keys_seen ON hd_alert_keys(integration_id, last_seen);
CREATE TABLE IF NOT EXISTS hd_intake_deliveries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_id integer NOT NULL REFERENCES hd_integrations(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  status_code integer NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL DEFAULT '',
  ticket_id integer REFERENCES hd_tickets(id) ON DELETE SET NULL,
  dedup_key text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_hd_intake_deliveries ON hd_intake_deliveries(integration_id, id DESC);
CREATE TABLE IF NOT EXISTS hd_intake_requests (
  integration_id integer NOT NULL REFERENCES hd_integrations(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  response jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (integration_id, request_key)
);
CREATE INDEX IF NOT EXISTS idx_hd_intake_requests_at ON hd_intake_requests(created_at);
-- One ALTER per column: db.ts's boot guard (guardAddColumns) checks only the
-- first column of a statement, so a later-added column would be skipped.
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS automated integer NOT NULL DEFAULT 0;
-- An email integration accepts mail with no SPF/DKIM/DMARC verdict only when
-- the admin turned this on (1.19.0 review: fail closed by default).
ALTER TABLE hd_integrations ADD COLUMN IF NOT EXISTS allow_unverified_mail integer NOT NULL DEFAULT 0;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS integration_id integer REFERENCES hd_integrations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_integration ON hd_tickets(integration_id) WHERE integration_id IS NOT NULL;
`;

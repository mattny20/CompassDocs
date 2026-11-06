// Helpdesk 1.19.1: recurring tickets' schema (agent V8). Kept apart from
// lib/helpdesk/recurring (server code) so lib/db's SCHEMA string can append
// it without importing anything. Additive and idempotent; append after
// hd_tickets (it references hd_teams, hd_request_types, hd_tickets, users).
//
//   hd_recurring       one schedule: a team, a subject and body template
//                      ({{month}} {{date}} {{week}} {{team}} placeholders),
//                      priority, request type, who it goes to (assign_mode
//                      'team_rules' = the team's assignment rules, 'user' =
//                      assignee_id), a due in business days, the pattern
//                      (jsonb, lib/helpdesk/recurring-shared RecurringPattern),
//                      what a holiday does (next_working_day | skip |
//                      same_day), the wall-clock time zone, on/off, and the
//                      next run: next_run_at (the instant) with next_key
//                      (the occurrence it is: its scheduled local date).
//   hd_recurring_runs  the occurrences that opened a ticket, keyed
//                      (recurring_id, occurrence_key): the sweep claims the
//                      key in the transaction that inserts the ticket, so a
//                      crash or a second instance never opens two.

export const HD_RECURRING_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_recurring (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id integer NOT NULL REFERENCES hd_teams(id) ON DELETE CASCADE,
  subject text NOT NULL,
  body text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal',
  request_type_id integer REFERENCES hd_request_types(id) ON DELETE SET NULL,
  assign_mode text NOT NULL DEFAULT 'team_rules',
  assignee_id integer REFERENCES users(id) ON DELETE SET NULL,
  due_business_days integer,
  pattern jsonb NOT NULL,
  holiday_rule text NOT NULL DEFAULT 'next_working_day',
  timezone text NOT NULL DEFAULT 'UTC',
  enabled integer NOT NULL DEFAULT 1,
  next_run_at timestamptz,
  next_key text,
  last_run_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_recurring_due ON hd_recurring (next_run_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_hd_recurring_team ON hd_recurring (team_id);
CREATE TABLE IF NOT EXISTS hd_recurring_runs (
  recurring_id integer NOT NULL REFERENCES hd_recurring(id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  ticket_id integer REFERENCES hd_tickets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recurring_id, occurrence_key)
);
`;

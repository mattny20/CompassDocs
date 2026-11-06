// Helpdesk 1.19.0: ticket assignment's schema (agent N). Kept apart from
// lib/helpdesk/assignment (server code) so lib/db's SCHEMA string can append
// it without importing anything. Additive and idempotent, every default
// constant, like the rest of the Helpdesk block. Append after hd_messages
// (it references hd_teams, hd_tickets and users).
//
//   hd_team_assignment     per team: how new tickets find an owner (manual =
//                          they wait in the queue; round_robin; load_balanced),
//                          who is eligible, capacity, shifts, sticky
//                          requester and the reassignment options.
//   hd_assignment_members  per team member: weight (round robin turns, load
//                          share) and paused (opted out of auto-assignment).
//                          No row = weight 1, not paused.
//   hd_assignment_cursor   the round-robin pointer per team (last person and
//                          how many turns in a row they have had), updated
//                          under a row lock.
//   hd_assignment_rules    ordered rules that run before the team's mode:
//                          conditions {match, rules[]} and an action.
//   hd_assignment_log      every assignment, automatic or by hand.
//   hd_assignment_ticket   per ticket: queued since (nobody was eligible;
//                          the sweep retries), the pending decision, and how
//                          many times it was reassigned automatically (max 3).
//   hd_on_call             who is on call for a team, when (rows from the
//                          rotation, or one-off overrides).
//   hd_on_call_rotation    the rotation: ordered people, length in days,
//                          handover time and weekday in a timezone.

export const HD_ASSIGNMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_team_assignment (
  team_id integer PRIMARY KEY REFERENCES hd_teams(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'manual',
  eligible text NOT NULL DEFAULT 'available',
  include_roles jsonb NOT NULL DEFAULT '["agent","team_lead"]',
  max_open_per_agent integer,
  respect_shift integer NOT NULL DEFAULT 1,
  sticky_requester integer NOT NULL DEFAULT 0,
  reassign_when_away integer NOT NULL DEFAULT 0,
  unanswered_minutes integer,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_assignment_members (
  team_id integer NOT NULL REFERENCES hd_teams(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight integer NOT NULL DEFAULT 1,
  paused integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_assignment_members_user ON hd_assignment_members(user_id);
CREATE TABLE IF NOT EXISTS hd_assignment_cursor (
  team_id integer PRIMARY KEY REFERENCES hd_teams(id) ON DELETE CASCADE,
  last_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  streak integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_assignment_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  enabled integer NOT NULL DEFAULT 1,
  scope_team_id integer REFERENCES hd_teams(id) ON DELETE CASCADE,
  conditions jsonb NOT NULL DEFAULT '{}',
  action jsonb NOT NULL DEFAULT '{}',
  stop integer NOT NULL DEFAULT 1,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_assignment_rules_order ON hd_assignment_rules(position, id) WHERE enabled = 1;
CREATE TABLE IF NOT EXISTS hd_assignment_log (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  rule_id integer REFERENCES hd_assignment_rules(id) ON DELETE SET NULL,
  rule_name text NOT NULL DEFAULT '',
  from_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  to_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  team_id integer REFERENCES hd_teams(id) ON DELETE SET NULL,
  actor_id integer REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_hd_assignment_log_ticket ON hd_assignment_log(ticket_id, at);
CREATE INDEX IF NOT EXISTS idx_hd_assignment_log_to ON hd_assignment_log(to_user_id, at DESC);
CREATE TABLE IF NOT EXISTS hd_assignment_ticket (
  ticket_id integer PRIMARY KEY REFERENCES hd_tickets(id) ON DELETE CASCADE,
  queued_since timestamptz,
  queued_reason text NOT NULL DEFAULT '',
  decision jsonb NOT NULL DEFAULT '{}',
  auto_reassigns integer NOT NULL DEFAULT 0,
  cap_noted integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_assignment_ticket_queued ON hd_assignment_ticket(queued_since) WHERE queued_since IS NOT NULL;
CREATE TABLE IF NOT EXISTS hd_on_call (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id integer NOT NULL REFERENCES hd_teams(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'rotation',
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_hd_on_call_team ON hd_on_call(team_id, starts_at);
CREATE TABLE IF NOT EXISTS hd_on_call_rotation (
  team_id integer PRIMARY KEY REFERENCES hd_teams(id) ON DELETE CASCADE,
  user_ids jsonb NOT NULL DEFAULT '[]',
  length_days integer NOT NULL DEFAULT 7,
  handover_time text NOT NULL DEFAULT '09:00',
  timezone text NOT NULL DEFAULT 'UTC',
  starts_on date NOT NULL,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

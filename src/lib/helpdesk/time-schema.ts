// Helpdesk 1.19.1: time tracking's schema (agent V8). Kept apart from
// lib/helpdesk/time (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent; append after
// hd_tickets (it references hd_tickets, hd_teams and users).
//
//   hd_time_entries          time an agent spent on a ticket: minutes, a
//                            note, when it counts (logged_at), where it
//                            came from ('manual' | 'timer', with the
//                            timer's started_at). Agents only: requesters
//                            never see it.
//   hd_timers                the one running timer per agent (user_id is
//                            the key): which ticket, since when.
//   hd_teams.ask_time_on_solve  1 = the desk asks for time when an agent
//                            solves one of the team's tickets.

export const HD_TIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_time_entries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  note text NOT NULL DEFAULT '',
  started_at timestamptz,
  logged_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_time_entries_ticket ON hd_time_entries (ticket_id);
CREATE INDEX IF NOT EXISTS idx_hd_time_entries_logged ON hd_time_entries (logged_at);
CREATE INDEX IF NOT EXISTS idx_hd_time_entries_user ON hd_time_entries (user_id, logged_at);
CREATE TABLE IF NOT EXISTS hd_timers (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hd_teams ADD COLUMN IF NOT EXISTS ask_time_on_solve integer NOT NULL DEFAULT 0;
`;

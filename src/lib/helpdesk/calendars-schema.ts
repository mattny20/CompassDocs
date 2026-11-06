// Helpdesk 1.19.0: business calendars and per-team reply targets (agent L).
// Kept apart from lib/helpdesk/calendars (server code) so lib/db's SCHEMA
// string can append it without importing anything. Additive and
// idempotent, every default constant, like the rest of the Helpdesk block.
// Append after hd_teams (it references hd_teams and users).
//
//   hd_calendars              office hours: a timezone and, per weekday
//                             (0 = Sunday … 6 = Saturday), a list of
//                             {start, end} "HH:MM" intervals ([] = closed;
//                             "00:00"–"24:00" = all day; end ≤ start runs
//                             past midnight). Exactly one is the default
//                             (teams without a calendar use it).
//   hd_holiday_sets           named lists of closures ("Company holidays",
//                             "UK bank holidays"), attached to calendars.
//   hd_holidays               a date with a name, whole day (closed_from /
//                             closed_to null) or part of it, optionally
//                             repeating every year.
//   hd_calendar_holiday_sets  which sets a calendar observes.
//   hd_teams.calendar_id      the team's calendar (null = the default).
//   hd_team_sla_targets       a team's own reply targets per priority; no
//                             row = the workspace policy (hd_sla_policies).

export const HD_CALENDARS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_calendars (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  timezone text NOT NULL,
  schedule jsonb NOT NULL DEFAULT '[[],[],[],[],[],[],[]]',
  is_default integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hd_calendars_one_default ON hd_calendars ((1)) WHERE is_default = 1;
CREATE TABLE IF NOT EXISTS hd_holiday_sets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS hd_holidays (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_id integer NOT NULL REFERENCES hd_holiday_sets(id) ON DELETE CASCADE,
  date date NOT NULL,
  name text NOT NULL,
  recurring_yearly integer NOT NULL DEFAULT 0,
  closed_from text,
  closed_to text,
  UNIQUE (set_id, date, name)
);
CREATE INDEX IF NOT EXISTS hd_holidays_set_date ON hd_holidays (set_id, date);
CREATE TABLE IF NOT EXISTS hd_calendar_holiday_sets (
  calendar_id integer NOT NULL REFERENCES hd_calendars(id) ON DELETE CASCADE,
  set_id integer NOT NULL REFERENCES hd_holiday_sets(id) ON DELETE CASCADE,
  PRIMARY KEY (calendar_id, set_id)
);
ALTER TABLE hd_teams ADD COLUMN IF NOT EXISTS calendar_id integer REFERENCES hd_calendars(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS hd_team_sla_targets (
  team_id integer NOT NULL REFERENCES hd_teams(id) ON DELETE CASCADE,
  priority text NOT NULL,
  first_reply_minutes integer NOT NULL,
  resolve_minutes integer NOT NULL,
  business_hours integer NOT NULL DEFAULT 1,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, priority)
);
`;

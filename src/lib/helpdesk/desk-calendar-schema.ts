// Helpdesk 1.20.6: the desk's event calendar. Kept apart from
// lib/helpdesk/desk-calendar (server code) so lib/db's SCHEMA string can
// append it without importing anything. Additive and idempotent; append
// after hd_tickets, hd_teams, hd_request_types and users.
//
// (Not to be confused with lib/helpdesk/calendars-schema: those are the
// business-hours "Calendars" a team's reply targets count in. This is the
// "Calendar" of events that tickets carry.)
//
//   hd_ticket_events     a ticket's one event (ticket_id is the key). The
//                        instants are UTC (starts_at, ends_at); an all-day
//                        event also keeps its calendar days (start_date to
//                        end_date, inclusive) and the zone they were entered
//                        in, and its instants are those days' midnights in
//                        that zone. ready_at = starts_at minus the setup
//                        lead time, stored so the reminder sweep and the
//                        calendar read one indexed column. place_key is the
//                        place trimmed, single-spaced and lower-cased: what
//                        the double-booking check compares. setup_done_*:
//                        "Setup complete", who and when. cancelled_at: the
//                        meeting was cancelled (an invite's METHOD:CANCEL, or
//                        a declined request); a cancelled event blocks
//                        nothing. ics_uid / ics_sequence: the meeting invite
//                        it came from, so an update finds it. time_rev goes
//                        up whenever the time or the lead time changes: the
//                        reminders already sent belong to the old revision,
//                        so they are sent again for the new one.
//   hd_event_reminders   what the reminder sweep has sent, keyed (ticket,
//                        kind, time_rev): the claim that makes a reminder go
//                        out once across restarts and instances. kind is
//                        'lead:<minutes>' or 'late'.
//   hd_calendar_feeds    private iCal feed links. One live link per person
//                        per scope (a team, or NULL = every team the person
//                        works). Only the SHA-256 of the token is kept, with
//                        its last four characters for display. The feed
//                        shows what its owner may see when it is fetched.
//   hd_calendar_prefs    what a person last chose on the Calendar page
//                        (view, team filter, colours, layers).
//   hd_request_types.calendar   "Goes on the calendar": which form fields
//                        hold the start, end and place, and the default
//                        setup lead time. '{}' = off.

export const HD_DESK_CALENDAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_ticket_events (
  ticket_id integer PRIMARY KEY REFERENCES hd_tickets(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day integer NOT NULL DEFAULT 0,
  start_date date,
  end_date date,
  timezone text NOT NULL DEFAULT 'UTC',
  place text NOT NULL DEFAULT '',
  place_key text NOT NULL DEFAULT '',
  setup_minutes integer NOT NULL DEFAULT 0,
  ready_at timestamptz NOT NULL,
  setup_done_at timestamptz,
  setup_done_by integer REFERENCES users(id) ON DELETE SET NULL,
  setup_done_by_name text NOT NULL DEFAULT '',
  cancelled_at timestamptz,
  source text NOT NULL DEFAULT 'agent',
  ics_uid text NOT NULL DEFAULT '',
  ics_sequence integer NOT NULL DEFAULT 0,
  repeats integer NOT NULL DEFAULT 0,
  time_rev integer NOT NULL DEFAULT 1,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_start ON hd_ticket_events (starts_at);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_end ON hd_ticket_events (ends_at);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_place ON hd_ticket_events (place_key, starts_at) WHERE place_key <> '' AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_uid ON hd_ticket_events (ics_uid) WHERE ics_uid <> '';
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_ready ON hd_ticket_events (ready_at) WHERE setup_done_at IS NULL AND cancelled_at IS NULL;
CREATE TABLE IF NOT EXISTS hd_event_reminders (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  kind text NOT NULL,
  time_rev integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, kind, time_rev)
);
CREATE TABLE IF NOT EXISTS hd_calendar_feeds (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES hd_teams(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_name text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calendar_feeds_live ON hd_calendar_feeds (owner_id, COALESCE(team_id, 0)) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS hd_calendar_prefs (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hd_request_types ADD COLUMN IF NOT EXISTS calendar jsonb NOT NULL DEFAULT '{}'::jsonb;
`;

/**
 * lib/helpdesk/retention's auto-close (solved → closed): never a ticket whose
 * event's setup is not marked complete. Reads hd_tickets' columns, as its
 * CLOSE_WHERE does. Here (and not in lib/helpdesk/desk-calendar) so retention
 * imports nothing but a string.
 */
export const EVENT_HOLDS_CLOSE_SQL = `NOT EXISTS (SELECT 1 FROM hd_ticket_events ev WHERE ev.ticket_id = hd_tickets.id AND ev.cancelled_at IS NULL AND ev.setup_done_at IS NULL)`;

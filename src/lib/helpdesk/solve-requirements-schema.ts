// Helpdesk 1.20.5: "Before you solve" requirements' schema. Kept apart from
// lib/helpdesk/solve-requirements (server code) so lib/db's SCHEMA string can
// append it without importing anything. Additive and idempotent; append
// after hd_tickets (it references it).
//
//   hd_solve_requirement_sets  a requirement set (Desk settings → Before you
//                              solve): its name, whether it is on, its scope
//                              (team_ids and request_type_ids; both empty =
//                              every ticket), the ticket fields that must be
//                              set (ticket_fields: assignee | team | category
//                              | tag | asset | time | reply) and its closing
//                              fields as JSON (HdFormField[], the request
//                              form's field shape).
//   hd_ticket_solve_answers    a ticket's answers to closing fields, one row
//                              per (ticket, set, field key), each with the
//                              words it was asked in (set_name, label, type)
//                              and the answer as read (display), so a set
//                              that is edited or deleted later never rewrites
//                              what a solved ticket says. set_id has no
//                              foreign key on purpose: the answers outlive
//                              the set.
// Agents only: requesters, CCs and portal customers never read these.

export const HD_SOLVE_REQUIREMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_solve_requirement_sets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  enabled integer NOT NULL DEFAULT 0,
  team_ids integer[] NOT NULL DEFAULT '{}',
  request_type_ids integer[] NOT NULL DEFAULT '{}',
  ticket_fields text[] NOT NULL DEFAULT '{}',
  fields jsonb NOT NULL DEFAULT '[]',
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_ticket_solve_answers (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  set_id integer NOT NULL,
  field_key text NOT NULL,
  set_name text NOT NULL DEFAULT '',
  label text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'text',
  value jsonb,
  display text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  answered_by integer REFERENCES users(id) ON DELETE SET NULL,
  answered_by_name text NOT NULL DEFAULT '',
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, set_id, field_key)
);
`;

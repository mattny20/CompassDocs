// Helpdesk 1.20.6: custom fields' schema. Kept apart from
// lib/helpdesk/custom-fields (server code) so lib/db's SCHEMA string can
// append it without importing anything. Additive and idempotent; append
// after hd_tickets, hd_teams and hd_solve_requirement_sets (it references
// the first and adds one column to the last).
//
//   hd_custom_fields         a field a desk admin defines (Desk settings →
//                            Custom fields): its stable key (unique, made
//                            from the first label, never changed), label,
//                            kind (the request form's field types), help
//                            line, options for a choice (HdFormOption[]), the
//                            teams it is assigned to (all_teams = 1, or
//                            team_ids), who sees it (visibility: agent |
//                            public), its place in the list (position) and
//                            archived_at (archived: kept with its values, no
//                            longer shown or edited).
//   hd_ticket_custom_values  a ticket's value for a field, one row per
//                            (ticket, field). `display` is the value as a
//                            person read it when it was set (an option's
//                            label, a person's name), kept for an option that
//                            is removed later. A row is never removed by a
//                            team move: a field that is not assigned to the
//                            ticket's team is simply not shown. Deleting the
//                            field deletes its values (the settings page
//                            asks first and says how many tickets hold one).
//   hd_solve_requirement_sets.custom_field_ids
//                            the custom fields a "Before you solve" set
//                            requires (lib/helpdesk/solve-requirements). No
//                            foreign key: a deleted field drops out when the
//                            set is read.
// Agent-only fields never leave the agent side; requester routes read only
// visibility = 'public' (lib/helpdesk/custom-fields publicCustomDetails).

export const HD_CUSTOM_FIELDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_custom_fields (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  type text NOT NULL DEFAULT 'text',
  help text NOT NULL DEFAULT '',
  options jsonb NOT NULL DEFAULT '[]',
  all_teams integer NOT NULL DEFAULT 1,
  team_ids integer[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'agent',
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_ticket_custom_values (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  field_id integer NOT NULL REFERENCES hd_custom_fields(id) ON DELETE CASCADE,
  value jsonb NOT NULL,
  display text NOT NULL DEFAULT '',
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_custom_values_field ON hd_ticket_custom_values(field_id);
ALTER TABLE hd_solve_requirement_sets ADD COLUMN IF NOT EXISTS custom_field_ids integer[] NOT NULL DEFAULT '{}';
`;

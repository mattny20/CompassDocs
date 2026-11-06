// Helpdesk 1.19.2: checklists' schema (agent W3). Kept apart from
// lib/helpdesk/checklists (server code) so lib/db's SCHEMA string can append
// it without importing anything. Additive and idempotent; append after
// hd_tickets, hd_teams and hd_request_types (it references them).
//
//   hd_checklist_templates      a reusable list (Desk settings → Checklists):
//                               its name, its items as JSON
//                               ([{ key, title, required, team_id, due_days }],
//                               HdChecklistTemplateItem) and the request types
//                               that add it to every new request. Workflow
//                               tasks name templates in their own definition
//                               (HdTaskStepDefB.checklist_ids).
//   hd_ticket_checklists        one checklist on one ticket, copied from a
//                               template when added (a later template edit
//                               never changes a ticket's copy). source: manual
//                               | request_type | workflow (source_ref: the
//                               workflow step key). A ticket holds several.
//   hd_ticket_checklist_items   its items in order: required, the owner team,
//                               the due date (business days counted in a team
//                               calendar when added), and who ticked it when.
//                               ticket_id is kept on the item too, so the
//                               solve check is one indexed lookup.
// Agents only: requesters, CCs and portal customers never read these.

export const HD_CHECKLISTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_checklist_templates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',
  request_type_ids integer[] NOT NULL DEFAULT '{}',
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_ticket_checklists (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  template_id integer REFERENCES hd_checklist_templates(id) ON DELETE SET NULL,
  name text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  source_ref text NOT NULL DEFAULT '',
  added_by integer REFERENCES users(id) ON DELETE SET NULL,
  added_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_checklists_ticket ON hd_ticket_checklists (ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_checklists_template ON hd_ticket_checklists (template_id);
CREATE TABLE IF NOT EXISTS hd_ticket_checklist_items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checklist_id integer NOT NULL REFERENCES hd_ticket_checklists(id) ON DELETE CASCADE,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  required integer NOT NULL DEFAULT 0,
  team_id integer REFERENCES hd_teams(id) ON DELETE SET NULL,
  due_date date,
  due_at timestamptz,
  done_at timestamptz,
  done_by integer REFERENCES users(id) ON DELETE SET NULL,
  done_by_name text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_hd_checklist_items_list ON hd_ticket_checklist_items (checklist_id, position, id);
CREATE INDEX IF NOT EXISTS idx_hd_checklist_items_required_open ON hd_ticket_checklist_items (ticket_id) WHERE required = 1 AND done_at IS NULL;
`;

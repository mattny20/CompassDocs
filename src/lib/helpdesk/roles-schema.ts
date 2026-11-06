// Helpdesk 1.19.0: the desk role ladder's schema (agent J). Kept apart from
// lib/helpdesk/roles (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent, like the rest of the
// Helpdesk block.
//
//   hd_agent_roles   one desk role per person (newbie, agent, team_lead,
//                    manager, admin). No row: the role is derived from the
//                    workspace permissions (lib/helpdesk/roles hdRoleOf).
//   hd_messages      review_state: null (not reviewed), 'pending' (a
//                    newbie's public reply waiting for a lead), 'approved'
//                    (sent), 'returned' (sent back to the newbie with a note).

export const HD_ROLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_agent_roles (
  user_id     integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('newbie','agent','team_lead','manager','admin')),
  assigned_by integer REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
-- One ALTER per column: db.ts's boot guard (guardAddColumns) checks only the
-- first column of a statement, so a later-added column would be skipped.
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS review_state text;
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS reviewed_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS review_note text;
CREATE INDEX IF NOT EXISTS hd_messages_review_pending_idx ON hd_messages (ticket_id) WHERE review_state = 'pending';
`;

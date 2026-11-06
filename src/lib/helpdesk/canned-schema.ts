// Helpdesk 1.19.2: canned responses (agent W4). Kept apart from
// lib/helpdesk/canned (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent. Append after
// hd_teams and hd_tickets (it references both, and users).
//
//   hd_canned_responses   a text-only snippet an agent inserts at the cursor
//                         in a reply or an internal note (";" or the Canned
//                         response button). Never changes the ticket: that
//                         is what macros are for. Shared with:
//                           only its owner   owner_id set
//                           one team         team_id set (its team leads edit it)
//                           the workspace    neither set
//                         At most one of owner_id / team_id is set. A team's
//                         responses go with the team (the Delete team dialog
//                         says how many; the audit counts them); a person's
//                         with them. Limits: 200 personal per owner, 2,000
//                         team and workspace ones in all.
//     folder              a free-text folder name ('' = none)
//   hd_canned_uses        one row per insert, for "Used (30 days)": at most
//                         one per person, response and ticket an hour.
//                         Kept 90 days (lib/helpdesk/canned pruneCannedUses,
//                         from the helpdesk sweep). Indexed on ticket_id and
//                         user_id for their ON DELETE SET NULL.

export const HD_CANNED_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_canned_responses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  folder text NOT NULL DEFAULT '',
  owner_id integer REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES hd_teams(id) ON DELETE CASCADE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (owner_id IS NULL OR team_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_hd_canned_owner ON hd_canned_responses (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_canned_team ON hd_canned_responses (team_id) WHERE team_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS hd_canned_uses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canned_id integer NOT NULL REFERENCES hd_canned_responses(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  ticket_id integer REFERENCES hd_tickets(id) ON DELETE SET NULL,
  used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_canned_uses_recent ON hd_canned_uses (canned_id, used_at);
CREATE INDEX IF NOT EXISTS idx_hd_canned_uses_used_at ON hd_canned_uses (used_at);
CREATE INDEX IF NOT EXISTS idx_hd_canned_uses_ticket ON hd_canned_uses (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_canned_uses_user ON hd_canned_uses (user_id) WHERE user_id IS NOT NULL;
`;

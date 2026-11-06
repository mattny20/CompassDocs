// Helpdesk 1.19.1: CCs and followers' schema (agent V3). Kept apart from
// lib/helpdesk/ccs (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent; append after
// hd_tickets (it references hd_tickets and users).
//
//   hd_ticket_ccs        people copied on a request: a workspace account
//                        (user_id) or, when outside senders are allowed, an
//                        outside address (user_id NULL, email). One row per
//                        person per ticket: unique on (ticket_id, user_id)
//                        for accounts and (ticket_id, lower(email)) for
//                        outside addresses. CCs read the public
//                        conversation, reply in public and get the public
//                        replies; never internal notes.
//                        account_removed (1.19.1): the row of a person
//                        whose account was removed, kept as name and
//                        address only because the ticket is on legal hold
//                        (lib/helpdesk/retention keepHeldCcRowsTx). A record,
//                        not a CC: never mailed, never listed, never a CC's
//                        authority.
//   hd_ticket_followers  agents who follow a ticket and hear of its updates
//                        (desk_followed_update). muted = 1 keeps the row of
//                        someone who unfollowed, so replying again does not
//                        follow them back automatically.

export const HD_CC_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_ticket_ccs (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  added_by integer REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hd_ticket_ccs_user_uq ON hd_ticket_ccs (ticket_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hd_ticket_ccs_email_uq ON hd_ticket_ccs (ticket_id, lower(email)) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS hd_ticket_ccs_user_idx ON hd_ticket_ccs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hd_ticket_ccs_email_idx ON hd_ticket_ccs (lower(email)) WHERE user_id IS NULL;
ALTER TABLE hd_ticket_ccs ADD COLUMN IF NOT EXISTS account_removed boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS hd_ticket_followers (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by integer REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  muted smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX IF NOT EXISTS hd_ticket_followers_user_idx ON hd_ticket_followers (user_id);
`;

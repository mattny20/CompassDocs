// Helpdesk 1.19.1: reply drafts saved by the Claude connector (agent V1).
// Kept apart from lib/helpdesk/drafts (server code) so lib/db's SCHEMA
// string can append it without importing anything. Additive and
// idempotent, like the rest of the Helpdesk block. Append after hd_tickets.
//
//   hd_reply_drafts   a reply Claude drafted on a ticket for an agent to
//                     review. Never a message: it is not sent, emailed or
//                     shown to the requester. The desk shows a pending
//                     draft above the composer ("Draft from Claude"); an
//                     agent moves it into the composer (used_at) or
//                     discards it (discarded_at). Sending is the agent's
//                     own reply, under the normal rules (newbie review).
//     created_by      the person who asked Claude (set null when removed)
//     source          'claude' (the only writer today)

export const HD_DRAFTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_reply_drafts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'claude',
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  discarded_at timestamptz,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_hd_reply_drafts_pending ON hd_reply_drafts(ticket_id, created_at) WHERE discarded_at IS NULL AND used_at IS NULL;
`;

// Helpdesk 1.19.1: the customer portal's schema (agent V6). Kept apart from
// lib/helpdesk/portal (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent; append after
// hd_tickets (it adds a column there).
//
//   hd_portal_contacts  people outside the workspace who use the portal at
//                       /support. One row per address (stored lower-case,
//                       unique). blocked = 1: no sign-in link, no session,
//                       no new request, no reply (by the portal or by
//                       email), no notices.
//   hd_portal_links     one-time sign-in links: only the SHA-256 of the
//                       token is kept; 15 minutes, used once (used_at).
//                       next_path is where the link lands (a /support path).
//   hd_portal_sessions  a signed-in browser: SHA-256 of the cookie's token,
//                       30 days sliding (expires_at), with the address and
//                       browser it was opened from. Deleting the row signs
//                       the browser out.
//   hd_tickets.portal_contact_id
//                       the contact who raised a portal ticket (source
//                       'portal_external', requester_id NULL). A contact
//                       sees exactly the tickets carrying their id, and
//                       the tickets those were merged into.
//   idx_hd_portal_contacts_mailbox
//                       the address's mailbox (lower-case, "+tag" dropped:
//                       portal-shared canonicalMailbox), for per-address
//                       limits and blocks.

export const HD_PORTAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_portal_contacts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  blocked integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_portal_contacts_email ON hd_portal_contacts (lower(email));
CREATE INDEX IF NOT EXISTS idx_hd_portal_contacts_mailbox ON hd_portal_contacts ((regexp_replace(lower(email), '^([^+@]+)\\+[^@]*@', '\\1@')));
CREATE TABLE IF NOT EXISTS hd_portal_links (
  token_hash text PRIMARY KEY,
  contact_id integer NOT NULL REFERENCES hd_portal_contacts(id) ON DELETE CASCADE,
  next_path text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_hd_portal_links_contact ON hd_portal_links (contact_id, created_at);
CREATE TABLE IF NOT EXISTS hd_portal_sessions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id integer NOT NULL REFERENCES hd_portal_contacts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_hd_portal_sessions_contact ON hd_portal_sessions (contact_id);
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS portal_contact_id integer REFERENCES hd_portal_contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_portal_contact ON hd_tickets (portal_contact_id) WHERE portal_contact_id IS NOT NULL;
`;

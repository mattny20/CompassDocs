// Helpdesk 1.19.4 (C3): the customer portal help centre's schema. Kept
// apart from lib/helpdesk/help-centre (server code) so lib/db's SCHEMA
// string can append it without importing anything. Additive and
// idempotent; no foreign keys (nothing here points at a person).
//
// The help centre's settings are a workspace key (helpdesk_portal_hc), not
// a table. These two tables only feed the "Last 30 days" numbers on Desk
// settings → Customer portal → Help centre, and hold no personal data:
//
//   hd_hc_searches  one row per search someone settled on (typing extends
//                   the same row for a few seconds, so a typed word is one
//                   search, not one per key). q is the query lower-cased,
//                   with email addresses and long digit runs replaced
//                   (help-centre-shared redactQuery), at most 100
//                   characters. No contact, no account, no network address.
//                   journey is the browser tab's random id (below), or ''.
//   hd_hc_journeys  one row per browser tab that searched or opened a
//                   suggestion: a random id the page makes and keeps in
//                   sessionStorage (never a cookie, never tied to a
//                   contact or an address), whether it searched, how many
//                   articles it opened, and whether it then raised a
//                   request. "Answered without a request" counts the
//                   journeys that opened an article and raised nothing
//                   within 30 minutes.
//
// Both are pruned to 90 days as they are written (help-centre pruneOld),
// so neither needs a sweep, retention rule or export entry.
//
//   hd_portal_links.hc_journey
//                   the journey id of the tab that asked for a sign-in
//                   link ('' for none), handed to the browser that spends
//                   the link so a request raised there ends that journey
//                   ("answered without a request" must not count it). It
//                   lives as long as the link row (a day, portal sweep).

export const HD_HELP_CENTRE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_hc_searches (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journey text NOT NULL DEFAULT '',
  q text NOT NULL,
  results integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'home',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_hc_searches_at ON hd_hc_searches (at);
CREATE INDEX IF NOT EXISTS idx_hd_hc_searches_journey ON hd_hc_searches (journey, at) WHERE journey <> '';
CREATE TABLE IF NOT EXISTS hd_hc_journeys (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  searched boolean NOT NULL DEFAULT false,
  opened integer NOT NULL DEFAULT 0,
  submitted boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_hd_hc_journeys_started ON hd_hc_journeys (started_at);
ALTER TABLE hd_portal_links ADD COLUMN IF NOT EXISTS hc_journey text NOT NULL DEFAULT '';
`;

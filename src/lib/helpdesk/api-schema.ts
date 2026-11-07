// Helpdesk 1.19.4 (area C2): API tokens and outgoing webhooks. Kept apart
// from lib/helpdesk/api-tokens and lib/helpdesk/webhooks (server code) so
// lib/db's SCHEMA string can append it without importing anything. Additive
// and idempotent; append after hd_tickets and users (it references both).
//
//   hd_api_tokens          one row per token. Only the SHA-256 of the token
//                          is kept (token_hash) plus its last four
//                          characters for display. Each token has its own
//                          service account (principal_id): a users row with
//                          status 'service' and no password, which can never
//                          sign in, holds no workspace role and is left out
//                          of every people list. The desk role ladder reads
//                          the token's role and teams for that account
//                          (lib/helpdesk/roles roleRowFacts), so the token can
//                          do exactly what that role may do in those teams.
//                          A revoked token keeps its row (the audit trail and
//                          the "Shown as" name on what it wrote).
//   hd_webhooks            an outgoing webhook: https endpoint, events, team
//                          filter (empty = every team), whether internal
//                          notes are sent, and its signing secret sealed with
//                          lib/secretbox (never returned after creation).
//                          failing_since: the first failed attempt since the
//                          last success; the hook turns itself off when a
//                          delivery gives up after 24 hours while it has been
//                          failing for that long.
//   hd_webhook_deliveries  the queue and the delivery log. A row is queued
//                          after the write that caused it commits, claimed by
//                          one process (claimed_at), retried with backoff for
//                          24 hours, then 'failed'. payload is cleared once
//                          the row is finished, so only an undelivered event
//                          holds ticket text; anonymising a ticket drops its
//                          pending payloads. The newest 50 finished rows per
//                          hook are kept (status, response code, time and the
//                          first 2 KB of the response).

export const HD_API_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_api_tokens (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  last4 text NOT NULL,
  principal_id integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('newbie','agent','team_lead','manager')),
  team_ids integer[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS hd_webhooks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  team_ids integer[] NOT NULL DEFAULT '{}',
  include_notes boolean NOT NULL DEFAULT false,
  secret_sealed text NOT NULL,
  secret_last4 text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  disabled_reason text NOT NULL DEFAULT '',
  failing_since timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hook_id integer NOT NULL REFERENCES hd_webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  event_id text NOT NULL,
  ticket_id integer REFERENCES hd_tickets(id) ON DELETE SET NULL,
  ticket_number integer,
  test boolean NOT NULL DEFAULT false,
  payload jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  finished_at timestamptz,
  response_status integer,
  response_excerpt text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  duration_ms integer
);
-- 1.19.4 review: who caused the event (a person, or a token's service account), so
-- removing that account drops their undelivered events (retention anonymiseRemovedAccountTx).
ALTER TABLE hd_webhook_deliveries ADD COLUMN IF NOT EXISTS actor_id integer;
CREATE INDEX IF NOT EXISTS hd_webhook_deliveries_due_idx ON hd_webhook_deliveries (next_attempt_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS hd_webhook_deliveries_hook_idx ON hd_webhook_deliveries (hook_id, id DESC);
CREATE INDEX IF NOT EXISTS hd_webhook_deliveries_ticket_idx ON hd_webhook_deliveries (ticket_id) WHERE ticket_id IS NOT NULL;
`;

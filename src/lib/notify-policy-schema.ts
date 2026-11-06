// Notification preferences 1.19.0 (agent I): the schema of lib/notify-policy,
// in a file with no imports so lib/db can append it to SCHEMA_SQL without an
// import cycle (lib/notify-policy imports lib/db). Additive and idempotent.

export const NOTIFY_POLICY_SCHEMA = `
  --- Notification preferences 1.19.0 ------------------------------------
  CREATE TABLE IF NOT EXISTS user_notify_prefs (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS notify_digest_queue (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event text NOT NULL,
    mode text NOT NULL DEFAULT 'digest_hourly',
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    link text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_notify_digest_queue_user ON notify_digest_queue(user_id, created_at);
  -- Set the moment a digest carrying the row was accepted by the mailer:
  -- such a row is never released for another send, only deleted.
  ALTER TABLE notify_digest_queue ADD COLUMN IF NOT EXISTS sent_at timestamptz;
  CREATE TABLE IF NOT EXISTS notify_digest_state (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_daily_on date
  );
  --- end Notification preferences 1.19.0 --------------------------------
`;

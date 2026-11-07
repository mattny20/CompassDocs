// Helpdesk 1.19.4: chat apps, Microsoft Teams and Slack intake
// (lib/helpdesk/chat). Dependency-free DDL appended to lib/db's Helpdesk
// block, after hd_tickets and hd_request_types. New tables only.
//
//   hd_chat_people   a chat account linked to a CompassDocs account (Teams:
//                    the Entra object ID; Slack: the member ID), with the
//                    direct-message conversation the app may write to and
//                    the request a plain reply in that chat goes to (focus).
//                    Goes with the account (ON DELETE CASCADE).
//   hd_chat_threads  where a ticket lives in chat: Teams serviceUrl +
//                    conversation ID (+ the message replied to), Slack
//                    channel + thread_ts. Goes with the ticket and with the
//                    person's account; anonymising a ticket deletes it.
//   hd_chat_drafts   a "Raise a request?" card waiting for a click (one
//                    hour), and which ticket it raised, so a second click
//                    never raises a second ticket.
//   hd_chat_seen     event and activity ids already handled (Slack retries
//                    an event it thinks we missed); kept for a day.

export const HD_CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hd_chat_people (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    app text NOT NULL,
    chat_user_id text NOT NULL,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dm_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
    focus_ticket_id integer REFERENCES hd_tickets(id) ON DELETE SET NULL,
    focus_at timestamptz,
    checked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_chat_people_chat ON hd_chat_people(app, chat_user_id);
  CREATE INDEX IF NOT EXISTS idx_hd_chat_people_user ON hd_chat_people(user_id);

  CREATE TABLE IF NOT EXISTS hd_chat_threads (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
    app text NOT NULL,
    kind text NOT NULL DEFAULT 'dm',
    user_id integer REFERENCES users(id) ON DELETE CASCADE,
    service_url text NOT NULL DEFAULT '',
    conversation_id text NOT NULL,
    thread_id text NOT NULL DEFAULT '',
    link text NOT NULL DEFAULT '',
    -- The request the thread was opened for (kept when a merge moves the row; the personal data export names it).
    ticket_number integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hd_chat_threads_ticket ON hd_chat_threads(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_hd_chat_threads_conv ON hd_chat_threads(app, conversation_id, thread_id);
  -- One ticket per channel message, however many triggers arrive together (lib/helpdesk/chat/core openChannelTicket).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_chat_threads_channel_msg ON hd_chat_threads(app, conversation_id, thread_id) WHERE kind = 'channel';

  CREATE TABLE IF NOT EXISTS hd_chat_drafts (
    id text PRIMARY KEY,
    app text NOT NULL,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_user_id text NOT NULL,
    body text NOT NULL DEFAULT '',
    request_type_id integer REFERENCES hd_request_types(id) ON DELETE SET NULL,
    asset_id integer,
    origin jsonb NOT NULL DEFAULT '{}'::jsonb,
    ticket_id integer REFERENCES hd_tickets(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hd_chat_drafts_user ON hd_chat_drafts(user_id);

  CREATE TABLE IF NOT EXISTS hd_chat_seen (
    app text NOT NULL,
    event_id text NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app, event_id)
  );
`;

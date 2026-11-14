// Helpdesk 1.20.7: Microsoft 365 mailbox connection for desk email
// (lib/helpdesk/m365). Dependency-free so lib/db's SCHEMA string can append
// it; additive and idempotent; after HD_MAILBOXES_SCHEMA (it references
// hd_mailboxes). An older binary on the same database ignores all three
// tables. Nothing here is read on the ticket path.
//
//   hd_m365_mailboxes            one row per Microsoft 365 mailbox the desk
//                                reads through Microsoft Graph (a shared or a
//                                user mailbox, named by its main address).
//     address                    unique whatever its case.
//     graph_id                   the mailbox's object ID or sign-in name, when
//                                the admin gave one: Microsoft Graph is then
//                                asked by it instead of by the address ('' =
//                                by the address).
//     sub_id / sub_expires_at    the Graph change-notification subscription
//     sub_state                  for its Inbox ('' = none), the SHA-256 of the
//                                clientState Microsoft echoes on every
//                                notification (never the value itself), and
//     sub_error(_at)             Microsoft's refusal the last time it could
//                                not be created or renewed ('' = fine).
//     last_notified_at           the last notification that passed the check.
//     delta_link                 where the next delta query starts ('' = a
//                                full round).
//     poll_due                   a notification or a lifecycle event asked
//                                for a read before the timer is due.
//     last_poll_at / last_ok_at  the last read tried / the last that worked.
//     last_error(_at)            one plain sentence about the last failure.
//     taken_in / dropped         messages turned into tickets or replies, and
//                                messages the desk's rules dropped.
//     processed_folder_id        the "Processed" folder's id, once found or
//                                made.
//     inbox_folder_id            the Inbox's own id: a message a notification
//                                names is taken in only while it is there.
//     claimed_until              one app instance works a mailbox at a time.
//   hd_m365_messages             every message seen in a connected Inbox, by
//                                its Graph id: taken in exactly once whatever
//                                delivers it (notification, timer, restart,
//                                a second instance).
//     state                      working (claimed), done, failed.
//     attempts                   tries that Microsoft or the pipeline answered
//                                with a refusal; at the cap the message is
//                                left alone until "Try again".
//     deferrals / retry_at       tries that got no answer or "try later" (a
//                                timeout, 429, 5xx, the desk's own limits):
//                                not counted, tried again after retry_at.
//     filed                      marked read or moved after intake.
//     listed                     a delta read of the Inbox listed it. One only
//                                a notification named is taken in after
//                                Microsoft says it lies in the Inbox.
//     received_at, sender_domain, sender_check, sender_reason
//                                for the settings page's "Last messages":
//                                when, the From domain, how the sender check
//                                went and why. Never any content.
//   hd_m365_links                which Microsoft 365 mailbox a help address
//                                (hd_mailboxes) lives on. Several help
//                                addresses may point at one mailbox (aliases).
//     send_via                   replies about this address's tickets are
//                                sent through Graph as the mailbox.
//     send_error(_at)            Microsoft's refusal the last time one was
//                                turned down and went out by SMTP instead.

export const HD_M365_MAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_m365_mailboxes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address text NOT NULL,
  graph_id text NOT NULL DEFAULT '',
  sub_id text NOT NULL DEFAULT '',
  sub_expires_at timestamptz,
  sub_state text NOT NULL DEFAULT '',
  sub_error text NOT NULL DEFAULT '',
  sub_error_at timestamptz,
  last_notified_at timestamptz,
  delta_link text NOT NULL DEFAULT '',
  poll_due boolean NOT NULL DEFAULT false,
  last_poll_at timestamptz,
  last_ok_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  last_error_at timestamptz,
  taken_in integer NOT NULL DEFAULT 0,
  dropped integer NOT NULL DEFAULT 0,
  processed_folder_id text NOT NULL DEFAULT '',
  inbox_folder_id text NOT NULL DEFAULT '',
  claimed_until timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_m365_mailboxes_address ON hd_m365_mailboxes (lower(address));
CREATE TABLE IF NOT EXISTS hd_m365_messages (
  mailbox_id integer NOT NULL REFERENCES hd_m365_mailboxes(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  state text NOT NULL DEFAULT 'working',
  outcome text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  deferrals integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  error text NOT NULL DEFAULT '',
  filed boolean NOT NULL DEFAULT false,
  listed boolean NOT NULL DEFAULT false,
  received_at timestamptz,
  sender_domain text NOT NULL DEFAULT '',
  sender_check text NOT NULL DEFAULT '',
  sender_reason text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_hd_m365_messages_open ON hd_m365_messages (mailbox_id, state) WHERE state <> 'done' OR NOT filed;
CREATE INDEX IF NOT EXISTS idx_hd_m365_messages_updated ON hd_m365_messages (updated_at);
CREATE TABLE IF NOT EXISTS hd_m365_links (
  mailbox_id integer PRIMARY KEY REFERENCES hd_mailboxes(id) ON DELETE CASCADE,
  m365_mailbox_id integer NOT NULL REFERENCES hd_m365_mailboxes(id) ON DELETE CASCADE,
  send_via boolean NOT NULL DEFAULT false,
  send_error text NOT NULL DEFAULT '',
  send_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_m365_links_mailbox ON hd_m365_links (m365_mailbox_id);
`;

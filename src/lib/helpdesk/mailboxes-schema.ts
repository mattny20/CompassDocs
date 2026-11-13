// Helpdesk 1.20.2: several help addresses (mailboxes). Kept apart from
// lib/helpdesk/mailboxes (server code) so lib/db's SCHEMA string can append
// it without importing anything. Additive and idempotent, one ALTER per
// column; append after hd_teams and hd_tickets (it references both). A
// 1.20.1 binary on the same database ignores the table and the column and
// keeps reading helpdesk_settings.inbound_address / email_from_name, which
// the default mailbox is mirrored into.
//
//   hd_mailboxes                 one row per address people write to. All of
//                                them are forwarded to the one inbound
//                                webhook (lib/helpdesk/inbound).
//     address                    unique whatever its case (idx on lower()).
//     name                       the From name of mail sent about its tickets.
//     team_id                    the team new tickets on this address start
//                                in when nothing else picks one (a team's
//                                email alias wins; rules and automations run
//                                after). NULL = "No team (use routing)".
//     send_from                  replies go out From this address (the
//                                workspace mail provider must allow it);
//                                false = From the workspace's own address
//                                under this mailbox's name.
//     send_from_error(_at)       the provider's refusal the last time a mail
//                                From this address was turned down and went
//                                out from the workspace address instead; ''
//                                once one is accepted again. Logged and
//                                audited once per failure streak.
//     is_default                 exactly one while any exist (partial unique
//                                index): tickets with no address of their
//                                own and no team match use it.
//   hd_tickets.mailbox_id        the address the ticket came in on, or the
//                                one an agent chose to answer from. NULL =
//                                work it out (the team's mailbox, else the
//                                default). Config, not personal data.
//
// 1.20.5: send-from addresses (lib/helpdesk/send-addresses). The list an
// admin keeps of addresses replies may go out From; each help address picks
// one, or none. Additive again: a 1.20.4 binary on the same database ignores
// the table and the new column and keeps reading hd_mailboxes.send_from and
// send_from_error, which 1.20.5 mirrors from the pick in the transaction
// that changes it.
//
//   hd_send_addresses            one row per address mail may go out From,
//                                through the workspace mail server. The mail
//                                provider must allow each one.
//     address                    unique whatever its case (idx on lower()).
//     name                       its own From name; '' = the name of the help
//                                address that sends from it.
//     last_error(_at)            the provider's refusal the last time a mail
//                                From it was turned down and went out from the
//                                workspace address instead; '' once one is
//                                accepted again. Logged and audited once per
//                                failure streak.
//   hd_mailboxes.send_address_id the send-from address replies about this
//                                help address's tickets go out From. NULL =
//                                the workspace address. Removing a send-from
//                                address puts its help addresses back on NULL.
//   hd_mailboxes.send_from       (1.20.2 column, now a mirror) true exactly
//                                when the picked send-from address is the
//                                help address itself; send_from_error(_at)
//                                then carry that address's last_error(_at).

export const HD_MAILBOXES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_mailboxes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address text NOT NULL,
  name text NOT NULL DEFAULT '',
  team_id integer REFERENCES hd_teams(id) ON DELETE SET NULL,
  send_from boolean NOT NULL DEFAULT false,
  send_from_error text NOT NULL DEFAULT '',
  send_from_error_at timestamptz,
  is_default boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_mailboxes_address ON hd_mailboxes (lower(address));
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_mailboxes_default ON hd_mailboxes (is_default) WHERE is_default;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS mailbox_id integer REFERENCES hd_mailboxes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_mailbox ON hd_tickets(mailbox_id) WHERE mailbox_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS hd_send_addresses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address text NOT NULL,
  name text NOT NULL DEFAULT '',
  last_error text NOT NULL DEFAULT '',
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_send_addresses_address ON hd_send_addresses (lower(address));
ALTER TABLE hd_mailboxes ADD COLUMN IF NOT EXISTS send_address_id integer REFERENCES hd_send_addresses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hd_mailboxes_send_address ON hd_mailboxes(send_address_id) WHERE send_address_id IS NOT NULL;
`;

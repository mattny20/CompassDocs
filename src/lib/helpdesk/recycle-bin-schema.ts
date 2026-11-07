// Helpdesk 1.19.4: the recycle bin for deleted tickets (area C7). Kept apart
// from lib/helpdesk/recycle-bin so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent, one ALTER per
// column; append after hd_tickets (and after the retention schema).
//
//   hd_tickets.deleted_at       when the ticket went to the recycle bin;
//                               NULL = live. A binned ticket is hidden from
//                               every queue, count, search, report, requester
//                               view, the portal, the Claude connector and the
//                               sweeps, and is deleted for good BIN_DAYS later
//                               (lib/helpdesk/recycle-bin purgeSweep)
//   hd_tickets.deleted_by       who binned it (NULL for a system delete, such
//                               as a retention rule, or once their account went)
//   hd_tickets.deleted_by_name  the name shown in the bin ("Ana Kowalski",
//                               "Retention rule"), kept when the account goes
//   idx_hd_tickets_binned       the bin list and the purge sweep read only
//                               binned rows

export const HD_RECYCLE_BIN_SCHEMA = `
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS deleted_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS deleted_by_name text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_hd_tickets_binned ON hd_tickets(deleted_at) WHERE deleted_at IS NOT NULL;
`;

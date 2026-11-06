// Helpdesk 1.19.1: retention and privacy's schema (agent V5). Kept apart
// from lib/helpdesk/retention so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent, one ALTER per
// column; append after hd_tickets. The settings themselves are one JSON
// value under the settings key `helpdesk_retention`.
//
//   hd_tickets.legal_hold     1 = never auto-closed, anonymised or deleted
//                             by retention or account removal, whatever the
//                             settings say (set in the desk by settings.manage)
//   hd_tickets.legal_hold_by  who set it (NULL when off, or their account went)
//   hd_tickets.legal_hold_at  when it was set
//   hd_tickets.anonymised_at  when the ticket was anonymised (names, emails,
//                             message text and files removed; counts, times,
//                             team, priority and type kept for reports);
//                             NULL = not anonymised
//   idx_audit_target, idx_notifications_link  (1.19.1 review) anonymising a
//                             ticket scrubs its audit rows (by target) and
//                             its bells (by link) without a table scan each

export const HD_RETENTION_SCHEMA = `
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS legal_hold integer NOT NULL DEFAULT 0;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS legal_hold_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS legal_hold_at timestamptz;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS anonymised_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_retention_closed ON hd_tickets(closed_at) WHERE status = 'closed' AND anonymised_at IS NULL AND legal_hold = 0;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_retention_solved ON hd_tickets(solved_at) WHERE status = 'solved' AND legal_hold = 0;
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_notifications_link ON notifications(link text_pattern_ops);
`;

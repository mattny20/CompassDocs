// Helpdesk 1.19.1: merging tickets (agent V2). Kept apart from
// lib/helpdesk/merge (server code) so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent, one ALTER per column
// (test/schema-guard), no defaults to backfill: a 1.19.0 binary on the same
// database ignores both columns. Append after hd_messages.
//
//   hd_tickets.merged_into   the ticket this one was merged into (it is
//                            closed; its page links there, and email
//                            replies on its thread land there).
//   hd_messages.merged_from  the number of the ticket a message was moved
//                            from by a merge ("from #1051" on the target).

export const HD_MERGE_SCHEMA = `
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS merged_into integer REFERENCES hd_tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_merged_into ON hd_tickets(merged_into) WHERE merged_into IS NOT NULL;
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS merged_from integer;
`;

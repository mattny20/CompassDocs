// Helpdesk 1.19.4: share a ticket with an agent (area C6). Kept apart from
// lib/helpdesk/share so lib/db's SCHEMA string can append it without
// importing anything. Additive and idempotent, one ALTER per column; append
// after hd_messages.
//
//   hd_messages.event   a structured marker for a timeline line a feature
//                       writes on its own, NULL for every other message.
//                       'share' = "Ana shared this with Sam" (kind internal,
//                       via system), which the desk draws as one "Agents
//                       only" row. The line's text is never matched, so a
//                       note or checklist title that reads like a share is
//                       still drawn as what it is. No personal data.

export const HD_SHARE_SCHEMA = `
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS event text;
`;

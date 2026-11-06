// Helpdesk 1.19.1: paused time in business minutes (agent V5, the 1.19.0
// review's #26, second half). Kept apart from lib/helpdesk/calendars so
// lib/db's SCHEMA string can append it without importing anything.
// Additive and idempotent; append after hd_tickets.
//
//   hd_tickets.sla_paused_business_ms  the business time (in the team's
//       calendar when each pause ended) the ticket's clocks spent paused,
//       summed by lib/helpdesk/calendars bankPausedBusiness whenever a
//       pause ends. NULL = not tracked: a ticket that was already paused
//       before this column existed (sla_paused_ms > 0 then) stays NULL, and
//       a re-time from creation estimates its share instead. sla_paused_ms
//       (wall-clock) is unchanged and still counts 24/7 targets.

export const HD_SLA_PAUSE_SCHEMA = `
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS sla_paused_business_ms bigint;
`;

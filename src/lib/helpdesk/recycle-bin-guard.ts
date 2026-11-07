// Helpdesk 1.19.4 (C7): is a ticket in the recycle bin? The one-query check
// the senders call as a backstop (lib/helpdesk/email sendHelpdeskTemplate,
// notify-prefs deliverAgentNotification), so nothing is sent about a binned
// ticket whichever path asks to send. Depends on db-core only, so any
// module can import it without a cycle. Server-only.

import "server-only";
import { hqOne, type HdQueryable } from "./db-core";

/** True when the ticket (by id or number) exists and is in the recycle bin. Never throws (answers false on error). */
export async function ticketIsBinned(ref: { id?: number | null; number?: number | null }, client?: HdQueryable): Promise<boolean> {
  try {
    if (ref.id) return !!(await hqOne<{ x: number }>("SELECT 1 AS x FROM hd_tickets WHERE id = $1 AND deleted_at IS NOT NULL", [ref.id], client));
    if (ref.number) return !!(await hqOne<{ x: number }>("SELECT 1 AS x FROM hd_tickets WHERE number = $1 AND deleted_at IS NOT NULL", [ref.number], client));
  } catch (e) {
    console.error("[helpdesk] recycle bin check:", e);
  }
  return false;
}

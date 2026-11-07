// Helpdesk rows for the dashboard's "Needs your attention" (1.19.0; agent E
// renders them on the home page, the Get help badge sums them):
//
//   "N requests need your approval"        -> /help/approvals
//   "N of your requests are waiting on you" -> /help/requests
//
// Both answer 0 when the helpdesk is not licensed or the person may not use
// it, so the page can call them unconditionally. Server-only.

import "server-only";
import { canUseHelpdesk } from "./access";
import { hqOne } from "./db-core";
import type { Role } from "../types";

type U = { id: number; role: Role };

/** Approvals this person can decide now (B's rule: lib/helpdesk/approvals). */
export async function approvalsWaitingFor(user: U): Promise<number> {
  if (!(await canUseHelpdesk(user))) return 0;
  const { countMyPendingApprovals } = await import("./approvals");
  return countMyPendingApprovals(user);
}

/** This person's own requests waiting on them (status pending: "Waiting on you"). */
export async function requestsWaitingOn(user: U): Promise<number> {
  if (!(await canUseHelpdesk(user))) return 0;
  const r = await hqOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM hd_tickets WHERE requester_id = $1 AND status = 'pending' AND parent_ticket_id IS NULL AND deleted_at IS NULL",
    [user.id]
  );
  return r?.n ?? 0;
}

export interface HdAttentionRow {
  key: "hd_approvals" | "hd_waiting";
  count: number;
  label: string;
  href: string;
}

/** Both rows, those with a count only, worded for the dashboard. */
export async function helpdeskAttention(user: U): Promise<HdAttentionRow[]> {
  const [approvals, waiting] = await Promise.all([approvalsWaitingFor(user), requestsWaitingOn(user)]);
  const rows: HdAttentionRow[] = [];
  if (approvals > 0) {
    rows.push({
      key: "hd_approvals",
      count: approvals,
      label: `${approvals} ${approvals === 1 ? "request needs" : "requests need"} your approval`,
      href: "/help/approvals",
    });
  }
  if (waiting > 0) {
    rows.push({
      key: "hd_waiting",
      count: waiting,
      label: `${waiting} of your requests ${waiting === 1 ? "is" : "are"} waiting on you`,
      href: "/help/requests",
    });
  }
  return rows;
}

import "server-only";

// The Get help badge (1.19.0): work waiting on this person in the helpdesk,
// the approvals they can decide plus their own requests waiting on them
// (status "Waiting on you"). The sidebar counts it only when the entry
// shows; a helpdesk that cannot answer shows no badge rather than breaking
// the shell.

import { countMyPendingApprovals } from "@/lib/helpdesk/approvals";
import { countWaitingOnRequester } from "@/lib/helpdesk/tickets";

export async function helpBadgeCount(user: { id: number }): Promise<number> {
  try {
    const [approvals, waiting] = await Promise.all([countMyPendingApprovals(user), countWaitingOnRequester(user.id)]);
    return approvals + waiting;
  } catch {
    return 0;
  }
}

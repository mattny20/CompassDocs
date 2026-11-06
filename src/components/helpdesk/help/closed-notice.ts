import "server-only";

// "Is the team that will answer closed right now?" (1.19.0, office hours
// and holidays from lib/helpdesk/calendars): the calendar's own sentence
// when it is, null when it is open or the calendar cannot answer. Shown
// above a request form and above an open request's progress.

import { teamOpenState } from "@/lib/helpdesk/calendars";
import { getTicketByNumber } from "@/lib/helpdesk/tickets";
import { canSeeTicket } from "@/lib/helpdesk/access";
import type { SessionUser } from "@/lib/types";

export async function teamClosedMessage(teamId: number | null): Promise<string | null> {
  try {
    const state = await teamOpenState(teamId, new Date());
    return state.open ? null : state.message || null;
  } catch {
    return null;
  }
}

/** For an open request the person may see: its team's closed sentence, else null. */
export async function requestClosedMessage(user: SessionUser, number: number): Promise<string | null> {
  try {
    const t = await getTicketByNumber(number);
    if (!t || t.status === "solved" || t.status === "closed") return null;
    if (!(await canSeeTicket(user, t))) return null;
    return teamClosedMessage(t.team_id);
  } catch {
    return null;
  }
}

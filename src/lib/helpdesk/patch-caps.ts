// Helpdesk 1.19.0: the desk-role capability each ticket field change
// needs, shared by every agent path that changes fields (the ticket PATCH
// route, applying a macro), so a macro can never do what its user's role
// may not. Server-only.

import "server-only";
import { hqOne } from "./db-core";
import { hdCan, HD_FORBIDDEN } from "./roles";
import type { HdTicket, HdTicketPatch } from "./types";
import type { SessionUser } from "../types";

export type PatchCapTicket = Pick<HdTicket, "team_id" | "status" | "priority" | "assignee_id">;

/**
 * The desk-role capability each change needs (lib/helpdesk/roles): status
 * change_status; priority change_priority; another team transfer_team (in
 * the current team); taking it (or letting go of one's own) assign_self;
 * someone in the ticket's team assign_team; anyone else assign_any.
 * Answers the first refusal, or null.
 */
export async function patchRefusal(user: SessionUser, t: PatchCapTicket, patch: HdTicketPatch): Promise<string | null> {
  const teamId = t.team_id;
  const need = async (ok: Promise<boolean>) => ((await ok) ? null : HD_FORBIDDEN);
  if (patch.status !== undefined && patch.status !== t.status) {
    const r = await need(hdCan(user, "tickets.change_status", { teamId }));
    if (r) return r;
  }
  if (patch.priority !== undefined && patch.priority !== t.priority) {
    const r = await need(hdCan(user, "tickets.change_priority", { teamId }));
    if (r) return r;
  }
  if (patch.team_id !== undefined && patch.team_id !== t.team_id) {
    const r = await need(hdCan(user, "tickets.transfer_team", { teamId }));
    if (r) return r;
  }
  if (patch.assignee_id !== undefined && patch.assignee_id !== t.assignee_id) {
    const to = patch.assignee_id;
    const selfOnly = to === user.id || (to === null && t.assignee_id === user.id);
    if (selfOnly) return need(hdCan(user, "tickets.assign_self", { teamId }));
    const targetTeam = patch.team_id !== undefined ? patch.team_id : teamId;
    const inTeam =
      to !== null && targetTeam !== null &&
      Boolean(await hqOne("SELECT 1 FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [targetTeam, to]));
    if (to === null || inTeam) {
      if (await hdCan(user, "tickets.assign_team", { teamId: targetTeam })) return null;
    }
    return need(hdCan(user, "tickets.assign_any"));
  }
  return null;
}

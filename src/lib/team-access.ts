// Who may open the team view (F4, 1.14.0), in one place: compliance.team_read
// opens every group (a role grant: the Compliance manager role holds it, and
// an administrator can be given it to debug a lead's view); leading a group
// (group_leads) opens the led ones when Program settings let leads see
// policy standing (ack_defaults.leads_see_policies: an opt-in, because
// widening what every existing lead can see is a permissions change).
//
// Read by GET and POST /api/compliance/team (the 403 and its reason), the
// section layout (the Team tab), the team page (its guard, then notFound())
// and GET /api/compliance/mine (`lead_team`: `allowed` and `leads`, because
// "You lead a team" is said only to someone who does), so none of them can
// disagree about who may open the page. One copy of the rule, nothing else.

import { userLeadGroups } from "@/lib/db";
import type { TeamPolicyRow } from "@/lib/db";
import { admits, grantsFor } from "@/lib/authz";
import { getComplianceSettings } from "@/lib/compliance-settings";

/** The route's 403 sentences. */
export const TEAM_NO_GROUPS = "You don't lead any groups.";
export const TEAM_LEADS_OFF = "Group leads don't see policy standing in this workspace.";

export type TeamViewAccess =
  | {
      allowed: true;
      /** compliance.team_read: every group, setting or not. */
      every: boolean;
      /** Leads at least one group (group_leads). */
      leads: boolean;
      /** The groups this person leads, by name (every group the permission opens is the caller's to list). */
      groups: { id: number; name: string }[];
    }
  | { allowed: false; every: false; leads: boolean; groups: { id: number; name: string }[]; reason: string };

export async function teamViewAccess(userId: number): Promise<TeamViewAccess> {
  const [groups, grants, settings] = await Promise.all([userLeadGroups(userId), grantsFor(userId), getComplianceSettings()]);
  const every = admits(grants, "compliance.team_read");
  const leads = groups.length > 0;
  if (every || (leads && settings.ack_defaults.leads_see_policies)) return { allowed: true, every, leads, groups };
  return { allowed: false, every: false, leads, groups, reason: leads ? TEAM_LEADS_OFF : TEAM_NO_GROUPS };
}

export async function teamViewAllowed(userId: number): Promise<boolean> {
  return (await teamViewAccess(userId)).allowed;
}

/**
 * A team page row: the route's row plus whether this viewer may remind it,
 * the POST's own rule (the viewer leads one of the member's groups, or holds
 * compliance.program_manage), so the page disables Remind where the POST
 * would answer 403 instead of offering a control that fails.
 */
export type TeamViewRow = TeamPolicyRow & { may_remind: boolean };

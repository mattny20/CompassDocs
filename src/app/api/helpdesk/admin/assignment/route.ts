// GET /api/helpdesk/admin/assignment   the teams the caller configures (with their modes), whether they
//                                      manage rules, the rule editor's choices and the field catalogue.
// Helpdesk 1.19.0 (agent N). agents.manage_team (in some team) or automations.manage.

import { NextResponse } from "next/server";
import { hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import { manageableTeams, ruleChoices } from "@/lib/helpdesk/assignment/routes";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate(["agents.manage_team", "automations.manage"]);
  if (gate instanceof NextResponse) return gate;
  const [teams, canRules, choices] = await Promise.all([manageableTeams(gate), hdCan(gate, "automations.manage"), ruleChoices()]);
  return NextResponse.json({ teams, can_manage_rules: canRules, choices });
}

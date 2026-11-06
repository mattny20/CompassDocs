// GET  /api/helpdesk/admin/assignment/rules   every assignment rule, in run order, and the editor's choices
// POST /api/helpdesk/admin/assignment/rules   { name, enabled?, scope_team_id?, conditions?, action, stop? }
// Helpdesk 1.19.0 (agent N). automations.manage. Audited as helpdesk.assignment.rule_created.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditAssignment, badRequest, ruleChoices, ruleRefsProblem } from "@/lib/helpdesk/assignment/routes";
import { AssignmentLimitError, createRule, listRules } from "@/lib/helpdesk/assignment/store";
import { validateRuleInput, type HdAssignRuleInput } from "@/lib/helpdesk/assignment/shared";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const [rules, choices] = await Promise.all([listRules(), ruleChoices()]);
  return NextResponse.json({ rules, choices });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 32 * 1024);
  if (!body) return badRequest("Send the rule as JSON.");
  const checked = validateRuleInput(body);
  if (!checked.ok) return badRequest(checked.error);
  const problem = await ruleRefsProblem(checked.value);
  if (problem) return badRequest(problem);
  let rule;
  try {
    rule = await createRule(checked.value as HdAssignRuleInput, gate.id);
  } catch (e) {
    if (e instanceof AssignmentLimitError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  await auditAssignment(req, gate, "helpdesk.assignment.rule_created", { type: "helpdesk_assignment_rule", id: rule.id, label: rule.name }, {
    scope_team_id: rule.scope_team_id,
    conditions: rule.conditions,
    action: rule.action,
    enabled: rule.enabled,
    stop: rule.stop,
  });
  return NextResponse.json({ rule }, { status: 201 });
}

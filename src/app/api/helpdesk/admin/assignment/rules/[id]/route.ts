// PATCH  /api/helpdesk/admin/assignment/rules/[id]   any of { name, enabled, scope_team_id, conditions, action, stop }
// DELETE /api/helpdesk/admin/assignment/rules/[id]
// Helpdesk 1.19.0 (agent N). automations.manage.
// Audited as helpdesk.assignment.rule_updated / helpdesk.assignment.rule_deleted.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditAssignment, badRequest, idParam, notFound, ruleRefsProblem } from "@/lib/helpdesk/assignment/routes";
import { deleteRule, getRule, updateRule } from "@/lib/helpdesk/assignment/store";
import { validateRuleInput } from "@/lib/helpdesk/assignment/shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  const before = id ? await getRule(id) : undefined;
  if (!id || !before) return notFound();
  const body = await readJson(req, 32 * 1024);
  if (!body) return badRequest("Send the changes as JSON.");
  const checked = validateRuleInput(body, true);
  if (!checked.ok) return badRequest(checked.error);
  const problem = await ruleRefsProblem({ scope_team_id: checked.value.scope_team_id, action: checked.value.action });
  if (problem) return badRequest(problem);
  const rule = await updateRule(id, checked.value);
  if (!rule) return notFound();
  const changed = Object.keys(checked.value).filter(
    (k) => JSON.stringify((before as unknown as Record<string, unknown>)[k]) !== JSON.stringify((rule as unknown as Record<string, unknown>)[k])
  );
  if (changed.length) {
    await auditAssignment(req, gate, "helpdesk.assignment.rule_updated", { type: "helpdesk_assignment_rule", id, label: rule.name }, {
      changed,
      ...(changed.includes("enabled") ? { enabled: rule.enabled } : {}),
      ...(changed.includes("action") ? { action: rule.action } : {}),
      ...(changed.includes("conditions") ? { conditions: rule.conditions } : {}),
    });
  }
  return NextResponse.json({ rule });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idParam((await ctx.params).id);
  const gone = id ? await deleteRule(id) : undefined;
  if (!gone) return notFound();
  await auditAssignment(req, gate, "helpdesk.assignment.rule_deleted", { type: "helpdesk_assignment_rule", id: gone.id, label: gone.name }, {
    action: gone.action,
    conditions: gone.conditions,
  });
  return NextResponse.json({ ok: true });
}

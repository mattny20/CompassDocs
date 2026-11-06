// POST /api/helpdesk/admin/assignment/rules/reorder   { ids: number[] }  the run order, first to last
// Helpdesk 1.19.0 (agent N). automations.manage. Every rule must be named once.
// Audited as helpdesk.assignment.rules_reordered.

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditAssignment, badRequest } from "@/lib/helpdesk/assignment/routes";
import { listRules, reorderRules } from "@/lib/helpdesk/assignment/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson<{ ids?: unknown }>(req, 16 * 1024);
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : null;
  if (!ids || !ids.every((n) => Number.isInteger(n) && n > 0) || !(await reorderRules(ids))) {
    return badRequest("Send every rule's id once, in the new order.");
  }
  await auditAssignment(req, gate, "helpdesk.assignment.rules_reordered", { type: "helpdesk_assignment_rule" }, { ids });
  return NextResponse.json({ rules: await listRules() });
}

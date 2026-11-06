// GET  /api/helpdesk/admin/automations   every automation, in run order, with the event labels
// POST /api/helpdesk/admin/automations   { name, event, conditions?, actions, active?, position? }
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Audited as helpdesk.automation.created.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import {
  AutomationLimitError,
  HD_AUTOMATION_EVENT_LABEL,
  createAutomation,
  listAutomations,
  validateAutomationInput,
  type AutomationInput,
} from "@/lib/helpdesk/automations";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ automations: await listAutomations(), events: HD_AUTOMATION_EVENT_LABEL });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the automation as JSON." }, { status: 400 });
  const input = await validateAutomationInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  let automation;
  try {
    automation = await createAutomation(input.value as AutomationInput);
  } catch (e) {
    if (e instanceof AutomationLimitError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.automation.created",
    targetType: "helpdesk_automation",
    targetId: automation.id,
    targetLabel: automation.name,
    details: { event: automation.event, conditions: automation.conditions, actions: Object.keys(automation.actions), active: automation.active },
    ip: ipFrom(req),
  });
  return NextResponse.json({ automation }, { status: 201 });
}

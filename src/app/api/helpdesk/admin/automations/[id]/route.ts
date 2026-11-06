// GET    /api/helpdesk/admin/automations/[id]
// PATCH  /api/helpdesk/admin/automations/[id]   any of { name, event, conditions, actions, active, position }
// DELETE /api/helpdesk/admin/automations/[id]
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Audited as helpdesk.automation.updated / .deleted.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { deleteAutomation, getAutomation, updateAutomation, validateAutomationInput } from "@/lib/helpdesk/automations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<number | null> {
  const n = Number((await ctx.params).id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  const automation = id ? await getAutomation(id) : undefined;
  if (!automation) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  return NextResponse.json({ automation });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  if (!id) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const input = await validateAutomationInput(body, true);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const before = await getAutomation(id);
  if (!before) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  const automation = await updateAutomation(id, input.value);
  if (!automation) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.automation.updated",
    targetType: "helpdesk_automation",
    targetId: id,
    targetLabel: automation.name,
    details: { changed: Object.keys(input.value), active: automation.active, event: automation.event },
    ip: ipFrom(req),
  });
  return NextResponse.json({ automation });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  const gone = id ? await deleteAutomation(id) : undefined;
  if (!gone) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.automation.deleted",
    targetType: "helpdesk_automation",
    targetId: gone.id,
    targetLabel: gone.name,
    details: { event: gone.event },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

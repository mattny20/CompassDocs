// POST /api/helpdesk/admin/workflows/[id]/publish
// The draft, checked again, becomes what new requests run (version + 1).
// Requests already on their way keep the version they started with.
// Helpdesk 1.19.0 (desk capability workflows.manage).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { publishWorkflow } from "@/lib/helpdesk/workflows";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const raw = (await ctx.params).id;
  if (!/^\d{1,9}$/.test(raw)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const result = await publishWorkflow(Number(raw));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.published",
    targetType: "helpdesk_workflow",
    targetId: result.workflow.id,
    targetLabel: result.workflow.title,
    details: { version: result.version, steps: result.workflow.definition.steps.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ workflow: result.workflow, version: result.version });
}

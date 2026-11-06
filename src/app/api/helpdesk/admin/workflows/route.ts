// GET  /api/helpdesk/admin/workflows   every workflow, with run counts and linked request types
// POST /api/helpdesk/admin/workflows   { title, slug?, description?, definition? }  a new, unpublished workflow
// Helpdesk 1.19.0 (desk capability workflows.manage). The steps go into the draft; publishing
// (POST …/[id]/publish) makes them what new requests run.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { createWorkflow, EMPTY_DEFINITION, listWorkflows, validateWorkflowDefinition, validateWorkflowMeta } from "@/lib/helpdesk/workflows";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ workflows: await listWorkflows() });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 256 * 1024);
  if (!body) return NextResponse.json({ error: "Send the workflow as JSON." }, { status: 400 });
  const meta = await validateWorkflowMeta(body);
  if (!meta.ok) return NextResponse.json({ error: meta.error }, { status: 400 });
  const def = body.definition === undefined ? { ok: true as const, value: EMPTY_DEFINITION } : await validateWorkflowDefinition(body.definition);
  if (!def.ok) return NextResponse.json({ error: def.error }, { status: 400 });
  const workflow = await createWorkflow(meta.value, def.value);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.created",
    targetType: "helpdesk_workflow",
    targetId: workflow.id,
    targetLabel: workflow.title,
    details: { slug: workflow.slug, steps: def.value.steps.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ workflow }, { status: 201 });
}

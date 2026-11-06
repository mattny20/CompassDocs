// GET    /api/helpdesk/admin/workflows/[id]   the workflow (published definition + draft)
// PATCH  /api/helpdesk/admin/workflows/[id]   { title?, slug?, description?, draft? }
//          draft: the builder's steps, saved unpublished; draft: null throws the edits away
// DELETE /api/helpdesk/admin/workflows/[id]   linked request types stop starting runs;
//          runs already on their way finish on the version they pinned
// Helpdesk 1.19.0 (desk capability workflows.manage).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import {
  deleteWorkflow,
  discardWorkflowDraft,
  getWorkflow,
  saveWorkflowDraft,
  validateWorkflowDefinition,
  validateWorkflowMeta,
} from "@/lib/helpdesk/workflows";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const workflow = id === null ? undefined : await getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ workflow });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const existing = id === null ? undefined : await getWorkflow(id);
  if (!existing || id === null) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJson(req, 256 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });

  if (body.draft === null) {
    if (!existing.published) return NextResponse.json({ error: "An unpublished workflow has only its draft." }, { status: 400 });
    const workflow = await discardWorkflowDraft(id);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.workflow.draft_discarded",
      targetType: "helpdesk_workflow",
      targetId: id,
      targetLabel: existing.title,
      ip: ipFrom(req),
    });
    return NextResponse.json({ workflow });
  }

  const meta = await validateWorkflowMeta(body, existing);
  if (!meta.ok) return NextResponse.json({ error: meta.error }, { status: 400 });
  let draft;
  if (body.draft !== undefined) {
    const checked = await validateWorkflowDefinition(body.draft, id);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    draft = checked.value;
  }
  const workflow = await saveWorkflowDraft(id, meta.value, draft);
  if (!workflow) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.updated",
    targetType: "helpdesk_workflow",
    targetId: id,
    targetLabel: workflow.title,
    details: {
      fields: Object.keys(body).filter((k) => ["title", "slug", "description", "draft"].includes(k)),
      steps: draft ? draft.steps.length : undefined,
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ workflow });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const removed = id === null ? undefined : await deleteWorkflow(id);
  if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.deleted",
    targetType: "helpdesk_workflow",
    targetId: removed.id,
    targetLabel: removed.title,
    details: { version: removed.version, published: removed.published === 1, runs_open: removed.runs_open },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

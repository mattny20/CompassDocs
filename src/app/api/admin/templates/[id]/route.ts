import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getTemplate,
  updateTemplate,
  deleteTemplate,
  resetBuiltinTemplate,
} from "@/lib/doc-templates";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser, DocType } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id } = await params;
  const tpl = await getTemplate(Number(id));
  if (!tpl) return NextResponse.json({ error: "Template not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  // Restore a built-in's shipped content.
  if (body?.action === "reset") {
    const restored = await resetBuiltinTemplate(tpl.id);
    if (!restored) return NextResponse.json({ error: "Only built-ins can be reset." }, { status: 400 });
    await audit({
      actor: actorFrom(user),
      action: "settings.template_reset",
      targetType: "template",
      targetId: tpl.id,
      targetLabel: restored.name,
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, template: restored });
  }

  const updated = await updateTemplate(tpl.id, {
    ...(body?.name !== undefined ? { name: String(body.name).trim() } : {}),
    ...(body?.description !== undefined ? { description: String(body.description).trim() } : {}),
    ...(TYPES.includes(body?.doc_type) ? { doc_type: body.doc_type } : {}),
    ...(body?.title_pattern !== undefined ? { title_pattern: String(body.title_pattern).trim() } : {}),
    ...(body?.summary !== undefined ? { summary: String(body.summary).trim() } : {}),
    ...(body?.tags !== undefined ? { tags: String(body.tags).trim() } : {}),
    ...(body?.body !== undefined ? { body: String(body.body) } : {}),
    ...(typeof body?.hidden === "boolean" ? { hidden: body.hidden ? 1 : 0 } : {}),
  });
  await audit({
    actor: actorFrom(user),
    action: "settings.template_updated",
    targetType: "template",
    targetId: tpl.id,
    targetLabel: updated?.name ?? tpl.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, template: updated });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id } = await params;
  const tpl = await getTemplate(Number(id));
  if (!tpl) return NextResponse.json({ error: "Template not found." }, { status: 404 });
  if (tpl.builtin_key) {
    return NextResponse.json(
      { error: "Built-in templates can't be deleted — hide them instead." },
      { status: 400 }
    );
  }
  await deleteTemplate(tpl.id);
  await audit({
    actor: actorFrom(user),
    action: "settings.template_deleted",
    targetType: "template",
    targetId: tpl.id,
    targetLabel: tpl.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

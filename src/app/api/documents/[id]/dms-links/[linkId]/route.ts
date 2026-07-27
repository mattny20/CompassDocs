import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getDocument, deleteDmsLink } from "@/lib/db";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; linkId: string }> }
) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const { id, linkId } = await ctx.params;

  const doc = await getDocument(Number(id));
  if (!doc || !scopeAllows(await spaceScopeFor(gate), doc.space_id)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!(await canEditSpace(gate, doc.space_id))) {
    return NextResponse.json({ error: "You can't edit this space." }, { status: 403 });
  }

  const removed = await deleteDmsLink(doc.id, Number(linkId));
  if (!removed) return NextResponse.json({ error: "Link not found." }, { status: 404 });

  await audit({
    actor: actorFrom(gate),
    action: "document.dms_link_remove",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: { system: removed.system, title: removed.title },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

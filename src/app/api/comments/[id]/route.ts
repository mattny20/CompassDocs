import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getDocComment, softDeleteDocComment } from "@/lib/db";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Delete (soft) a comment: admins can remove ANY comment (moderation);
// authors can remove their own. The row stays so the thread keeps its shape,
// but the body never leaves the server again. Recorded in the audit log.

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;

  const { id } = await ctx.params;
  const comment = await getDocComment(Number(id));
  if (!comment) return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(gate), comment.space_id)) {
    return NextResponse.json({ error: "Comment not found." }, { status: 404 });
  }

  const isAdmin = gate.role === "admin";
  const isAuthor = comment.user_id === gate.id;
  if (!isAdmin && !isAuthor) {
    return NextResponse.json({ error: "You can only delete your own comments." }, { status: 403 });
  }

  const label = isAdmin && !isAuthor ? "an admin" : gate.name || gate.username;
  const changed = await softDeleteDocComment(comment.id, label);
  if (changed) {
    await audit({
      actor: actorFrom(gate),
      action: "comment.delete",
      targetType: "document",
      targetId: comment.document_id,
      targetLabel: `comment by ${comment.author_name}`,
      details: { moderation: isAdmin && !isAuthor },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ok: true });
}

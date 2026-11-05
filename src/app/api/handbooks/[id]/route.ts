import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import { deleteHandbook, getHandbook, parseHandbookPatch, parseIfUpdatedAt, updateHandbook } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// One handbook (1.18.0).
//
//   GET    → { handbook }. The reader's view (published items only) for
//          anyone who may read it; `?edit=1` is the editor's view (every
//          live item, drafts marked by doc_status; every section) and is
//          404 for anyone who may not edit. Not readable = 404.
//   PATCH  { title?, space_id?, introduction?, audience?, group_ids?,
//          confirm_whole?, require_signature?, if_updated_at? } →
//          { handbook, updated_at } (editor's view; updated_at is the new
//          token). Moving the owner needs handbook.manage on the new owner
//          as well (403). A published handbook cannot be left with a
//          'groups' audience and no group (400). Changing the owner or who
//          reads it is refused (403) while it holds a document from a space
//          the editor could not add from. With `if_updated_at` (the
//          handbook's updated_at as last loaded) the save is conditional:
//          409 "This handbook was changed by someone else…" and nothing
//          written when another save came first. Audited as
//          handbook.updated {changed, …} when anything changed.
//   DELETE → { ok: true }. Sections, items and the audience go; the
//          documents and every confirmation record stay. Audited as
//          handbook.deleted.
//
// 404 for a handbook the caller can't see; 403 "You can't edit this
// handbook." for a reader who tries to change it.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const forEdit = new URL(req.url).searchParams.get("edit") === "1";
  const handbook = await getHandbook(gate, id, { forEdit });
  if (!handbook) return notFound();
  return NextResponse.json({ handbook }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const parsed = parseHandbookPatch(b.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const token = parseIfUpdatedAt(b.body);
  if (!token.ok) return NextResponse.json({ error: token.error }, { status: 400 });
  return answer(async () => {
    const handbook = await updateHandbook(gate, id, parsed.value, req, { ifUpdatedAt: token.value });
    return { handbook, updated_at: handbook.updated_at };
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  return answer(async () => {
    await deleteHandbook(gate, id, req);
    return { ok: true };
  });
}

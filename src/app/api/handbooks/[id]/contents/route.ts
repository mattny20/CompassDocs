import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import { parseHandbookContents, parseIfUpdatedAt, setHandbookContents } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// The Contents card, saved whole (1.18.0).
//
//   PUT { sections: [{ id?, title, doc_ids }], if_updated_at? } →
//       { handbook, updated_at } (editor's view; updated_at is the new
//       token). With `if_updated_at` (the handbook's updated_at as last
//       loaded) the save is conditional: 409 "This handbook was changed by
//       someone else…" and nothing written when another save came first. Sections in order (an id keeps that section, none makes a
//       new one, a section left out is removed), each with its documents
//       in order; 1–50 sections, up to 200 documents, each once. A
//       document new to the handbook must be published, live, not
//       retired, and in a space the editor may add from (any space they
//       can see for a workspace handbook; the spaces they manage for a
//       space handbook): 400 otherwise. Written under the handbook's row
//       lock in one transaction. Audited as handbook.contents_changed
//       {added, removed, sections, sections_before} when anything moved.

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const parsed = parseHandbookContents(b.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const token = parseIfUpdatedAt(b.body);
  if (!token.ok) return NextResponse.json({ error: token.error }, { status: 400 });
  return answer(async () => {
    const handbook = await setHandbookContents(gate, id, parsed.value, req, { ifUpdatedAt: token.value });
    return { handbook, updated_at: handbook.updated_at };
  });
}

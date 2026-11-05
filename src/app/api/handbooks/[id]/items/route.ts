import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import { addHandbookItems, HANDBOOK_DOC_IDS_INVALID, HANDBOOK_ITEMS_MAX } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// Add documents to a handbook (1.18.0) — the "Add policies" tick.
//
//   POST { doc_ids, section_id? } → { handbook } (editor's view). Appends
//        to the end of `section_id` (default: the last section); a
//        document already in the handbook is skipped. The addable rule is
//        PUT …/contents's (400). Audited as handbook.contents_changed.

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const body = (b.body ?? {}) as { doc_ids?: unknown; section_id?: unknown };
  const ids = Array.isArray(body.doc_ids) ? body.doc_ids : null;
  if (!ids || ids.length < 1 || ids.length > HANDBOOK_ITEMS_MAX || ids.some((d) => typeof d !== "number" || !Number.isSafeInteger(d) || d <= 0)) {
    return NextResponse.json({ error: HANDBOOK_DOC_IDS_INVALID }, { status: 400 });
  }
  const section = body.section_id;
  if (section !== undefined && section !== null && (typeof section !== "number" || !Number.isSafeInteger(section) || section <= 0)) {
    return NextResponse.json({ error: "'section_id' must be a section id." }, { status: 400 });
  }
  return answer(async () => ({
    handbook: await addHandbookItems(gate, id, ids as number[], typeof section === "number" ? section : undefined, req),
  }));
}

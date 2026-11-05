import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import { addHandbookSection, HANDBOOK_SECTION_TITLE_MAX } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// Add a section to a handbook (1.18.0).
//
//   POST { title? } → 201 { handbook } (editor's view): a new empty
//        section at the end ("New section" when no title is sent; up to
//        120 characters). 400 past 50 sections. Audited as
//        handbook.contents_changed.

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const title = (b.body as { title?: unknown } | null)?.title;
  if (title !== undefined && (typeof title !== "string" || title.trim().length > HANDBOOK_SECTION_TITLE_MAX)) {
    return NextResponse.json({ error: `Name the section in up to ${HANDBOOK_SECTION_TITLE_MAX} characters.` }, { status: 400 });
  }
  return answer(async () => ({ handbook: await addHandbookSection(gate, id, typeof title === "string" ? title : "", req) }), 201);
}

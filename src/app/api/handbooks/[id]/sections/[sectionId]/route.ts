import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import { HANDBOOK_NOTHING_TO_CHANGE, moveHandbookSection, removeHandbookSection, renameHandbookSection } from "@/lib/handbooks";
import type { Handbook } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// One section of a handbook (1.18.0).
//
//   PATCH  { title?, move? } → { handbook } (editor's view): rename
//          (1–120 characters, 400 otherwise) and/or move 'up' | 'down'.
//   DELETE → { handbook }: the section goes and its documents move to the
//          end of the previous section (the start of the next for the
//          first). 409 "A handbook keeps at least one section." for the
//          last one.
//
// Both audited as handbook.contents_changed; 404 for a section that is not
// this handbook's.

type Ctx = { params: Promise<{ id: string; sectionId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const id = pathId(p.id);
  const sectionId = pathId(p.sectionId);
  if (!id || !sectionId) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const body = (b.body ?? {}) as { title?: unknown; move?: unknown };
  if (body.title !== undefined && typeof body.title !== "string") {
    return NextResponse.json({ error: "'title' must be text." }, { status: 400 });
  }
  if (body.move !== undefined && body.move !== "up" && body.move !== "down") {
    return NextResponse.json({ error: "'move' must be 'up' or 'down'." }, { status: 400 });
  }
  if (body.title === undefined && body.move === undefined) {
    return NextResponse.json({ error: HANDBOOK_NOTHING_TO_CHANGE }, { status: 400 });
  }
  return answer(async () => {
    let handbook: Handbook | undefined;
    if (typeof body.title === "string") handbook = await renameHandbookSection(gate, id, sectionId, body.title, req);
    if (body.move === "up" || body.move === "down") handbook = await moveHandbookSection(gate, id, sectionId, body.move, req);
    return { handbook };
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const id = pathId(p.id);
  const sectionId = pathId(p.sectionId);
  if (!id || !sectionId) return notFound();
  return answer(async () => ({ handbook: await removeHandbookSection(gate, id, sectionId, req) }));
}

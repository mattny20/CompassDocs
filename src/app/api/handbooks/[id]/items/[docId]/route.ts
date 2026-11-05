import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import {
  HANDBOOK_FIND_MODE_INVALID,
  HANDBOOK_NOTHING_TO_CHANGE,
  isFindMode,
  moveHandbookItem,
  removeHandbookItem,
  setItemFindMode,
} from "@/lib/handbooks";
import type { Handbook } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// One document in a handbook (1.18.0).
//
//   PATCH  { find_mode?, move?, section_id? } → { handbook } (editor's view).
//          find_mode 'space' | 'handbook_only' is "Where people find it",
//          stored on the document (every handbook it is in shows the same);
//          it needs handbook.manage where the document lives (403
//          otherwise) and is audited as handbook.find_mode_changed.
//          move 'up' | 'down' moves it one place in reading order, into
//          the neighbouring section at an edge; section_id moves it to the
//          end of that section. Audited as handbook.contents_changed.
//   DELETE → { handbook }: removed from this handbook (the document is
//          untouched). Audited as handbook.contents_changed.
//
// 404 when the document is not in the handbook.

type Ctx = { params: Promise<{ id: string; docId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const id = pathId(p.id);
  const docId = pathId(p.docId);
  if (!id || !docId) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const body = (b.body ?? {}) as { find_mode?: unknown; move?: unknown; section_id?: unknown };
  if (body.find_mode !== undefined && !isFindMode(body.find_mode)) {
    return NextResponse.json({ error: HANDBOOK_FIND_MODE_INVALID }, { status: 400 });
  }
  if (body.move !== undefined && body.move !== "up" && body.move !== "down") {
    return NextResponse.json({ error: "'move' must be 'up' or 'down'." }, { status: 400 });
  }
  const section = body.section_id;
  if (section !== undefined && (typeof section !== "number" || !Number.isSafeInteger(section) || section <= 0)) {
    return NextResponse.json({ error: "'section_id' must be a section id." }, { status: 400 });
  }
  if (body.find_mode === undefined && body.move === undefined && section === undefined) {
    return NextResponse.json({ error: HANDBOOK_NOTHING_TO_CHANGE }, { status: 400 });
  }
  return answer(async () => {
    let handbook: Handbook | undefined;
    if (isFindMode(body.find_mode)) handbook = await setItemFindMode(gate, id, docId, body.find_mode, req);
    if (typeof section === "number") handbook = await moveHandbookItem(gate, id, docId, { sectionId: section }, req);
    if (body.move === "up" || body.move === "down") handbook = await moveHandbookItem(gate, id, docId, { direction: body.move }, req);
    return { handbook };
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const id = pathId(p.id);
  const docId = pathId(p.docId);
  if (!id || !docId) return notFound();
  return answer(async () => ({ handbook: await removeHandbookItem(gate, id, docId, req) }));
}

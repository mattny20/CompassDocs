import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, jsonBody, notFound, pathId } from "@/lib/handbook-api";
import { publishHandbook } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// Publish or unpublish a handbook (1.18.0).
//
//   POST { publish: boolean } → { handbook } (editor's view). Publishing
//        needs at least one published document in it (409 "Add at least
//        one published document before publishing.") and, for a 'groups'
//        audience, at least one group (409); and an editor who could add
//        from every space whose documents it holds (403 otherwise:
//        publishing opens them to its readers). Publishing what is already
//        published (or the reverse) changes nothing. Audited as
//        handbook.published / handbook.unpublished.
//   DELETE → the same as { publish: false }.

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const publish = (b.body as { publish?: unknown } | null)?.publish;
  if (typeof publish !== "boolean") return NextResponse.json({ error: "'publish' must be true or false." }, { status: 400 });
  return answer(async () => ({ handbook: await publishHandbook(gate, id, publish, req) }));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  return answer(async () => ({ handbook: await publishHandbook(gate, id, false, req) }));
}

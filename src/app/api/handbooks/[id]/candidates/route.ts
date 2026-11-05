import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { answer, notFound, pathId } from "@/lib/handbook-api";
import { handbookCandidates } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// The editor's "Add policies" search (1.18.0).
//
//   GET ?q=&type=policy|all&space=<id>&limit= → { candidates: HandbookCandidate[] }:
//       published, live, unretired documents the editor may add to this
//       handbook (any space they can see for a workspace handbook; the
//       spaces they manage for a space handbook), matching `q` in the
//       title or full text; type 'policy' (the default) or 'all'; one
//       space when `space` is given. Policies first, then title; up to
//       100 (default 50). `in_handbook` marks the ones already ticked.
//       404 for anyone who may not edit the handbook.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const gate = await apiGuard("admin", "handbook.manage");
  if (gate instanceof NextResponse) return gate;
  const id = pathId((await ctx.params).id);
  if (!id) return notFound();
  const sp = new URL(req.url).searchParams;
  const space = sp.get("space") ? pathId(sp.get("space")!) : null;
  const limit = Number(sp.get("limit")) || undefined;
  return answer(async () => ({
    candidates: await handbookCandidates(gate, id, {
      q: sp.get("q") ?? "",
      type: sp.get("type") === "all" ? "all" : "policy",
      spaceId: space,
      limit,
    }),
  }));
}

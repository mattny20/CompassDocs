import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { notFound, pathId } from "@/lib/handbook-api";
import { getHandbookPolicy } from "@/lib/handbooks";

export const dynamic = "force-dynamic";

// A document read through its handbook (1.18.0).
//
//   GET → { handbook, item, section, document, prev, next }: the document
//         (published, live) when this handbook opens it to the caller —
//         they may read the handbook and the document is in it — whether
//         or not they can open the document's space ("handbook access
//         opens its policies"). /doc/{id} is unchanged and keeps its own
//         space checks. 404 otherwise, never 403.

type Ctx = { params: Promise<{ id: string; docId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const id = pathId(p.id);
  const docId = pathId(p.docId);
  if (!id || !docId) return notFound();
  const policy = await getHandbookPolicy(gate, id, docId);
  if (!policy) return notFound();
  return NextResponse.json(policy, { headers: { "Cache-Control": "no-store" } });
}

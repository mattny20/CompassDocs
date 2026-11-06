// GET /api/helpdesk/suggest?q=&limit=   articles from the workspace's documents
//   [{doc_id, title, space_name, read_minutes, url}], under the caller's space
//   scope and handbook find scope (lib/helpdesk/suggest).
// Helpdesk 1.19.0 (helpdesk.request). Rate-limited like search.

import { NextResponse } from "next/server";
import { helpdeskGate, hdRateLimited, tooMany } from "@/lib/helpdesk/access";
import { suggestArticles } from "@/lib/helpdesk/suggest";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-suggest:${gate.id}`, 60, 60_000)) return tooMany();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const limit = Math.min(8, Math.max(1, Number(url.searchParams.get("limit")) || 5));
  return NextResponse.json({ articles: await suggestArticles(gate, q, limit) });
}

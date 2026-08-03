import { NextResponse } from "next/server";
import { v1Auth, v1Error, v1Holds } from "@/lib/v1-auth";
import { hybridSearchDocuments } from "@/lib/embeddings";
import { spaceScopeFor } from "@/lib/access";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/search?q= — the same hybrid (full-text + semantic when
 * configured) search the app uses, operators included (`type:`, `tag:`,
 * `space:`, `author:`, `status:`). Snippets come back as plain text.
 */
export async function GET(req: Request) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return v1Error(400, "'q' is required.");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 25));

  const hits = await hybridSearchDocuments(
    q,
    limit,
    await v1Holds(user, "document.read_draft"),
    await spaceScopeFor(user)
  );
  return NextResponse.json({
    items: hits.map((h) => ({
      id: h.id,
      title: h.title,
      type: h.type,
      status: h.status,
      space: { slug: h.space_slug, name: h.space_name },
      snippet: String(h.snippet || "").replace(/<\/?mark>/g, ""),
      match: h.match,
    })),
  });
}

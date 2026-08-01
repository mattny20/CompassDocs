import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { directoryRateLimited } from "@/lib/rate-limit";
import { searchPeopleTypeahead } from "@/lib/directory";

export const dynamic = "force-dynamic";

const MAX_Q = 80;

/**
 * People typeahead for the command palette — any signed-in user.
 *
 * Deliberately not /api/directory: that one has no limit, ships the full
 * base64 photo inline, and returns the admin-only field definitions. This
 * returns a narrow projection plus a photo *URL*, and hidden people are
 * excluded in SQL by searchPeopleTypeahead (no includeHidden option exists on
 * that path).
 *
 * An empty or unmatched `q` is 200 with an empty list, never a 400 — a
 * typeahead must not log an error on every backspace.
 */
export async function GET(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  if (directoryRateLimited(String(gate.id))) {
    return NextResponse.json({ error: "Too many requests — slow down a moment." }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
  const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit")) || 8));
  if (!q) return NextResponse.json({ people: [] });

  const rows = await searchPeopleTypeahead(q, limit);
  const people = rows.map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    department: p.department,
    email: p.email,
    // A URL, never the blob. ?v busts the browser cache when a Graph sync
    // replaces the photo.
    photo_url: p.has_photo
      ? `/api/directory/${p.id}/photo?v=${Math.floor((Date.parse(p.updated_at) || 0) / 1000)}`
      : null,
  }));
  return NextResponse.json({ people });
}

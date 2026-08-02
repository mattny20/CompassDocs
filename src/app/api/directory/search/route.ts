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
 * returns a narrow projection with a photo *presence flag* (the bytes come
 * from /api/directory/{id}/photo), and hidden people are excluded in SQL by
 * searchPeopleTypeahead (no includeHidden option exists on that path).
 *
 * An empty or unmatched `q` is 200 with an empty list, never a 400 — a
 * typeahead must not log an error on every backspace.
 */
export async function GET(req: Request) {
  const gate = await apiGuard("viewer", "directory.search");
  if (gate instanceof NextResponse) return gate;
  if (directoryRateLimited(String(gate.id))) {
    return NextResponse.json({ error: "Too many requests — slow down a moment." }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
  const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit")) || 8));
  if (!q) return NextResponse.json({ people: [] });

  // Already the exact projection the palette needs — no re-shaping here, and
  // notably no `photo`, `custom`, `hidden`, `assistant_*`, `source`, or
  // `external_id`.
  const people = await searchPeopleTypeahead(q, limit);
  return NextResponse.json({ people });
}

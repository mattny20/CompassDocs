import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { renderMetrics } from "@/lib/metrics";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function tokenMatches(header: string | null, expected: string): boolean {
  const supplied = header?.replace(/^Bearer\s+/i, "").trim() || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Prometheus scrape endpoint. Two ways in: a bearer token matching
 * COMPASSDOCS_METRICS_TOKEN (for scrapers), or a signed-in admin session (for
 * a human peeking in a browser). With no token configured, scrapers are locked
 * out and only admins can view.
 */
export async function GET(req: Request) {
  const expected = process.env.COMPASSDOCS_METRICS_TOKEN?.trim();
  let allowed = false;
  if (expected) allowed = tokenMatches(req.headers.get("authorization"), expected);
  if (!allowed) {
    const user = await getCurrentUser();
    allowed = user?.role === "admin";
  }
  if (!allowed) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  return new Response(await renderMetrics(), {
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

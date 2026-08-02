import { NextResponse } from "next/server";
import { listAuditLog, auditCategories } from "@/lib/audit";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/** Date-only (YYYY-MM-DD) filter values, expanded to UTC-day boundaries. */
function parseDay(raw: string | null, endOfDay: boolean): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z`;
}

export async function GET(req: Request) {
  const gate = await apiGuard("admin", "audit.read");
  if (gate instanceof NextResponse) return gate;

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const category = url.searchParams.get("category") || undefined;
  const from = parseDay(url.searchParams.get("from"), false);
  const to = parseDay(url.searchParams.get("to"), true);

  const [{ rows, total }, categories] = await Promise.all([
    listAuditLog({ limit, offset: page * limit, category, from, to }),
    auditCategories(),
  ]);

  return NextResponse.json({ rows, total, page, limit, categories });
}

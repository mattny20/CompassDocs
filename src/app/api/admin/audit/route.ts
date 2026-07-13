import { NextResponse } from "next/server";
import { listAuditLog, auditCategories } from "@/lib/audit";
import { apiGuard } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const category = url.searchParams.get("category") || undefined;

  const [{ rows, total }, categories] = await Promise.all([
    listAuditLog({ limit, offset: page * limit, category }),
    auditCategories(),
  ]);

  return NextResponse.json({ rows, total, page, limit, categories });
}

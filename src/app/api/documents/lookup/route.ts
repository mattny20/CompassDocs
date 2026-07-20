import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { pool } from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Lightweight title lookup for the editor's [[ link autocomplete and the
// parent-page picker: id + title + space, scope-filtered, no bodies.
export async function GET(req: Request) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const spaceId = Number(url.searchParams.get("space") ?? NaN);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 15)));

  const scope = await spaceScopeFor(user);
  const params: any[] = [];
  const where: string[] = ["d.deleted_at IS NULL", "d.branch_of IS NULL"];
  if (scope !== "all") {
    params.push(scope);
    where.push(`d.space_id = ANY($${params.length})`);
  }
  if (Number.isInteger(spaceId)) {
    params.push(spaceId);
    where.push(`d.space_id = $${params.length}`);
  }
  let order = "LOWER(d.title)";
  if (q) {
    params.push(`%${q}%`);
    where.push(`d.title ILIKE $${params.length}`);
    // Prefix/early matches first, then alphabetical.
    params.push(q.toLowerCase());
    order = `POSITION($${params.length} IN LOWER(d.title)), LOWER(d.title)`;
  }
  params.push(limit);

  const rows = (
    await pool().query(
      `SELECT d.id, d.title, d.status, d.parent_id, s.name AS space_name, s.icon AS space_icon
       FROM documents d JOIN spaces s ON s.id = d.space_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}
       LIMIT $${params.length}`,
      params
    )
  ).rows;
  return NextResponse.json({ docs: rows });
}

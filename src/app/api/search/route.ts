import { NextResponse } from "next/server";
import { searchDocuments } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit")) || 25, 50);
  if (!q) return NextResponse.json({ hits: [] });

  const includeDrafts = roleAtLeast(user.role, "editor");
  return NextResponse.json({ hits: searchDocuments(q, limit, includeDrafts) });
}

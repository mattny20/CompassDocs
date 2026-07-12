import { NextResponse } from "next/server";
import { searchDocuments } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit")) || 25, 50);
  if (!q) return NextResponse.json({ hits: [] });
  return NextResponse.json({ hits: searchDocuments(q, limit) });
}

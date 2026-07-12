import { NextResponse } from "next/server";
import { createDocument, getSpaceBySlug, listSpaces } from "@/lib/db";
import type { DocType, DocStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];

function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string")
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const title = String(body?.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });

  // Resolve the space by numeric id or slug.
  let spaceId: number | undefined;
  if (body?.space_id) spaceId = Number(body.space_id);
  else if (body?.space_slug) spaceId = getSpaceBySlug(String(body.space_slug))?.id;
  if (!spaceId) {
    const first = listSpaces()[0];
    spaceId = first?.id;
  }
  if (!spaceId) return NextResponse.json({ error: "No space available." }, { status: 400 });

  const type: DocType = TYPES.includes(body?.type) ? body.type : "knowledge";
  const status: DocStatus = STATUSES.includes(body?.status) ? body.status : "draft";

  const doc = createDocument({
    space_id: spaceId,
    title,
    type,
    status,
    content: String(body?.content ?? ""),
    summary: String(body?.summary ?? "").trim(),
    tags: normalizeTags(body?.tags),
    author: String(body?.author ?? "").trim() || "Anonymous",
  });

  return NextResponse.json({ doc }, { status: 201 });
}

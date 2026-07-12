import { NextResponse } from "next/server";
import { createDocument, getSpaceBySlug, listSpaces, getApprovalMode } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { roleAtLeast } from "@/lib/types";
import type { DocType, DocStatus, SessionUser } from "@/lib/types";

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
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const title = String(body?.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });

  let spaceId: number | undefined;
  if (body?.space_id) spaceId = Number(body.space_id);
  else if (body?.space_slug) spaceId = getSpaceBySlug(String(body.space_slug))?.id;
  if (!spaceId) spaceId = listSpaces()[0]?.id;
  if (!spaceId) return NextResponse.json({ error: "No space available." }, { status: 400 });

  const type: DocType = TYPES.includes(body?.type) ? body.type : "knowledge";
  const requested: DocStatus = STATUSES.includes(body?.status) ? body.status : "draft";

  // Editors in strict mode can't publish directly — new docs start as drafts.
  const canPublish = roleAtLeast(user.role, "approver") || getApprovalMode() === "open";
  const status: DocStatus = requested === "published" && !canPublish ? "draft" : requested;

  const doc = createDocument({
    space_id: spaceId,
    title,
    type,
    status,
    content: String(body?.content ?? ""),
    summary: String(body?.summary ?? "").trim(),
    tags: normalizeTags(body?.tags),
    author: user.name || user.username,
  });

  return NextResponse.json({ doc, downgraded: status !== requested }, { status: 201 });
}

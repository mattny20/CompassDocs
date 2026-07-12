import { NextResponse } from "next/server";
import { getDocument, updateDocument, deleteDocument } from "@/lib/db";
import type { DocType, DocStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: DocType[] = ["sop", "technical", "policy", "knowledge"];
const STATUSES: DocStatus[] = ["draft", "published"];

function normalizeTags(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
  if (typeof input === "string")
    return input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const patch: any = { versionNote: body?.versionNote };
  if (typeof body?.title === "string") patch.title = body.title.trim();
  if (typeof body?.content === "string") patch.content = body.content;
  if (typeof body?.summary === "string") patch.summary = body.summary.trim();
  if (TYPES.includes(body?.type)) patch.type = body.type;
  if (STATUSES.includes(body?.status)) patch.status = body.status;
  if (typeof body?.author === "string" && body.author.trim()) patch.author = body.author.trim();
  const tags = normalizeTags(body?.tags);
  if (tags !== undefined) patch.tags = tags;

  const doc = updateDocument(Number(id), patch);
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteDocument(Number(id));
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

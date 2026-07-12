import { NextResponse } from "next/server";
import { createSuggestion, getDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const text = String(body?.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "A suggestion message is required." }, { status: 400 });

  let documentId: number | null = null;
  if (body?.document_id != null) {
    const doc = getDocument(Number(body.document_id));
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    documentId = doc.id;
  }

  const id = createSuggestion({
    document_id: documentId,
    proposed_title: String(body?.proposed_title ?? "").trim(),
    body: text,
    created_by: user.id,
  });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

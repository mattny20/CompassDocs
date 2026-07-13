import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { getAttachment, getDocument, deleteAttachmentRow } from "@/lib/db";
import { uploadReadStream, deleteUpload, isInlineImage } from "@/lib/uploads";
import { roleAtLeast } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Serve an attachment. Any signed-in user (the whole site is private), except
// draft documents are only visible to editors+ — matching the doc read rules.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const att = await getAttachment(Number(id));
  if (!att) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const doc = await getDocument(att.document_id); // undefined if trashed
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const stream = uploadReadStream(att.stored_name);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const inline = isInlineImage(att.mime_type);
  const filename = encodeURIComponent(att.filename);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": inline ? att.mime_type : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      "Content-Length": String(att.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

// Delete an attachment (editors and up).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const row = await deleteAttachmentRow(Number(id));
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await deleteUpload(row.stored_name);
  return NextResponse.json({ ok: true });
}

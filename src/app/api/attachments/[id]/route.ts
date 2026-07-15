import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { spaceScopeFor, scopeAllows } from "@/lib/access";
import { getAttachment, getDocument, deleteAttachmentRow } from "@/lib/db";
import { getPublicSiteConfig } from "@/lib/public-site";
import { uploadReadStream, deleteUpload, isInlineImage } from "@/lib/uploads";
import { roleAtLeast } from "@/lib/types";

export const dynamic = "force-dynamic";

// Serve an attachment. Signed-in users follow their space scope (drafts are
// editors+ only). Anonymous requests are allowed exactly when the public site
// is enabled AND the attachment hangs off a published doc in a public space —
// the same rule as the public doc pages that link here.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();

  const { id } = await params;
  const att = await getAttachment(Number(id));
  if (!att) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const doc = await getDocument(att.document_id); // undefined if trashed
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });

  if (user) {
    if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
  } else {
    const publiclyVisible =
      doc.space_visibility === "public" &&
      doc.status === "published" &&
      (await getPublicSiteConfig()).enabled;
    if (!publiclyVisible) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
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

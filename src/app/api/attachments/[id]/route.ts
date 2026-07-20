import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { getAttachment, getDocument, deleteAttachmentRow } from "@/lib/db";
import { recordDownload } from "@/lib/analytics";
import { getPublicSiteConfig } from "@/lib/public-site";
import { uploadReadStream, deleteUpload, isInlineImage } from "@/lib/uploads";
import { roleAtLeast } from "@/lib/types";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Serve an attachment. Signed-in users follow their space scope (drafts are
// editors+ only). Anonymous requests are allowed exactly when the public site
// is enabled AND the attachment hangs off a published doc in a public space —
// the same rule as the public doc pages that link here.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
    // Anonymous: allowed via the public site, or via a share-link token that
    // covers exactly this attachment's document.
    const publiclyVisible =
      doc.space_visibility === "public" &&
      doc.status === "published" &&
      (await getPublicSiteConfig()).enabled;
    let sharedVisible = false;
    if (!publiclyVisible) {
      const token = new URL(req.url).searchParams.get("share");
      if (token) {
        const { resolveShare } = await import("@/lib/shares");
        const resolved = await resolveShare(token);
        sharedVisible = resolved?.doc.id === doc.id;
      }
    }
    if (!publiclyVisible && !sharedVisible) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
  }

  const stream = uploadReadStream(att.stored_name);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const inline = isInlineImage(att.mime_type);
  // Analytics: real file downloads only — inline images load on every page
  // view and would swamp the download counts.
  if (!inline) void recordDownload(att.id, doc.id, user?.id ?? null, att.filename).catch(() => {});
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

// Delete an attachment (editors and up, with edit rights on the doc's space).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const att = await getAttachment(Number(id));
  if (!att) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const doc = await getDocument(att.document_id);
  if (!doc || !scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await canEditSpace(user, doc.space_id))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

  const row = await deleteAttachmentRow(att.id);
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await deleteUpload(row.stored_name);
  return NextResponse.json({ ok: true });
}

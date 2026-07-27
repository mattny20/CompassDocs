import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { getDocument, createAttachment } from "@/lib/db";
import { saveUpload, safeExt } from "@/lib/uploads";
import { getAppSettings } from "@/lib/settings-store";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Upload an attachment to a document (editors and up).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (!scopeAllows(await spaceScopeFor(user), doc.space_id)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  if (!(await canEditSpace(user, doc.space_id))) {
    return NextResponse.json(
      { error: "You don't have edit access to this space." },
      { status: 403 }
    );
  }

  const { max_attachment_mb, max_video_mb } = await getAppSettings();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  // Videos get their own (larger) cap — screen recordings dwarf documents.
  const isVideo = (file.type || "").startsWith("video/");
  const capMb = isVideo ? Math.max(max_video_mb, max_attachment_mb) : max_attachment_mb;
  if (file.size > capMb * 1024 * 1024) {
    return NextResponse.json(
      { error: `File exceeds the ${capMb} MB ${isVideo ? "video " : ""}limit.` },
      { status: 413 }
    );
  }

  const ext = safeExt(file.name);
  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await saveUpload(buf, ext);
  const att = await createAttachment({
    document_id: doc.id,
    filename: (file.name || `file${ext}`).slice(0, 255),
    stored_name: stored,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    created_by: user.id,
  });

  return NextResponse.json({
    attachment: {
      id: att.id,
      filename: att.filename,
      size: att.size,
      mime_type: att.mime_type,
      url: `/api/attachments/${att.id}`,
    },
  });
}

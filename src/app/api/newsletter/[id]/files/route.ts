import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  addNewsletterFile,
  listNewsletterFiles,
} from "@/lib/db";
import { canEditContent } from "@/lib/newsletter-access";
import { saveUpload, safeExt } from "@/lib/uploads";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Attach a file to a newsletter: it's sent WITH the email as a real MIME
// attachment. Editable exactly when the content is.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);
  if (!canEditContent(user, n, approverIds)) {
    return NextResponse.json({ error: "You can't edit this newsletter." }, { status: 403 });
  }
  if ((await listNewsletterFiles(n.id)).length >= MAX_FILES) {
    return NextResponse.json(
      { error: `A newsletter can carry at most ${MAX_FILES} attachments.` },
      { status: 400 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Attach a file field named 'file'." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Attachments are limited to 5 MB each." }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await saveUpload(buf, safeExt(file.name));
  const row = await addNewsletterFile({
    newsletter_id: n.id,
    filename: file.name || "attachment",
    stored_name: stored,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
  });
  return NextResponse.json({ file: row }, { status: 201 });
}

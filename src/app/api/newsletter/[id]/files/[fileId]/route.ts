import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  getNewsletterFile,
  deleteNewsletterFileRow,
} from "@/lib/db";
import { canView, canEditContent } from "@/lib/newsletter-access";
import { uploadReadStream, uploadExists, deleteUpload } from "@/lib/uploads";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; fileId: string }> };

async function load(user: SessionUser, id: string, fileId: string) {
  const n = await getNewsletter(Number(id));
  if (!n) return null;
  const file = await getNewsletterFile(Number(fileId));
  if (!file || file.newsletter_id !== n.id) return null;
  const approverIds = await getNewsletterApproverIds(n.id);
  return { n, file, approverIds };
}

// Download an attachment (anyone who can view the newsletter). Served as a
// download regardless of type — recipients get the real file via email.
export async function GET(_req: Request, { params }: Params) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id, fileId } = await params;
  const ctx = await load(user, id, fileId);
  if (!ctx || !canView(user, ctx.n, ctx.approverIds)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (!(await uploadExists(ctx.file.stored_name))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const stream = uploadReadStream(ctx.file.stored_name);
  if (!stream) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(ctx.file.filename)}`,
      "Content-Length": String(ctx.file.size),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const { id, fileId } = await params;
  const ctx = await load(user, id, fileId);
  if (!ctx) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!canEditContent(user, ctx.n, ctx.approverIds)) {
    return NextResponse.json({ error: "You can't edit this newsletter." }, { status: 403 });
  }
  await deleteNewsletterFileRow(ctx.file.id);
  await deleteUpload(ctx.file.stored_name);
  return NextResponse.json({ ok: true });
}

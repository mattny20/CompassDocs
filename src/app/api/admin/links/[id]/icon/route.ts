import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getLink, updateLink } from "@/lib/db";
import { saveUpload, deleteUpload } from "@/lib/uploads";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Custom logo upload for a quick link. Small images only, and never SVG —
// the same script-safety policy as document attachments.
const ACCEPTED: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};
const MAX_BYTES = 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const link = await getLink(Number(id));
  if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });

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
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Icons are limited to 1 MB." }, { status: 413 });
  }
  const mime = (file.type || "").toLowerCase();
  if (!ACCEPTED[mime]) {
    return NextResponse.json(
      { error: "Use a PNG, JPEG, GIF, WebP, or ICO image." },
      { status: 415 }
    );
  }

  const stored = await saveUpload(Buffer.from(await file.arrayBuffer()), ACCEPTED[mime]);
  if (link.icon_file) await deleteUpload(link.icon_file);
  const updated = await updateLink(link.id, {
    icon_type: "custom",
    icon_file: stored,
    icon_mime: mime,
  });

  await audit({
    actor: actorFrom(gate),
    action: "link.icon_uploaded",
    targetLabel: link.title,
    ip: ipFrom(req),
  });
  return NextResponse.json({ link: updated });
}

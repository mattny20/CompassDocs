import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { canUseNewsletter } from "@/lib/newsletter-access";
import { saveUpload, safeExt } from "@/lib/uploads";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
// Only real raster images: these are served publicly (inboxes can't sign in),
// so anything that could carry markup (SVG, HTML) is refused outright.
const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

// Upload a newsletter image. Stored under an unguessable random name and
// served without auth from /api/newsletter/assets/[name] so the image works
// in recipients' inboxes.
export async function POST(req: Request) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!canUseNewsletter(user)) {
    return NextResponse.json({ error: "You don't have newsletter access." }, { status: 403 });
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
  const ext = IMAGE_EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "Only PNG, JPEG, GIF, or WebP images can be used in newsletters." },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Images are limited to 5 MB." }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await saveUpload(buf, ext);
  return NextResponse.json({ url: `/api/newsletter/assets/${stored}` }, { status: 201 });
}

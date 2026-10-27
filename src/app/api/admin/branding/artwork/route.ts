import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { ART_MAX_BYTES, ArtworkError, removeSignInArt, storeSignInArt } from "@/lib/sign-in-art";
import { sniffImage } from "@/lib/uploads";

export const dynamic = "force-dynamic";

// The sign-in page's artwork (1.16.0, Settings → Workspace → Sign-in page).
// Like the logo, an upload or a removal applies at once; it never waits for
// the page's Save. lib/sign-in-art does the work: the type is read from the
// bytes, sharp re-encodes the first frame at three widths (dropping camera
// and location data), and /api/brand/artwork serves the copies.

/** The body may carry the multipart envelope on top of the file itself. */
const MAX_BODY = ART_MAX_BYTES + 512 * 1024;
const TOO_BIG = "Artwork is limited to 15 MB.";
const NO_FILE = "Choose an image to upload.";
const WRONG_TYPE = "Use a JPEG, PNG, WebP or GIF image.";

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "workspace.branding_manage");
  if (gate instanceof NextResponse) return gate;

  // req.formData() buffers the whole body, and nothing in front of the app
  // caps it, so an oversized upload is refused before a byte is read.
  const length = Number(req.headers.get("content-length") || 0);
  if (length > MAX_BODY) return NextResponse.json({ error: TOO_BIG }, { status: 413 });
  if (!(req.headers.get("content-type") || "").includes("multipart/form-data")) {
    return NextResponse.json({ error: NO_FILE }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: NO_FILE }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: NO_FILE }, { status: 400 });
  if (file.size > ART_MAX_BYTES) return NextResponse.json({ error: TOO_BIG }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(buf)) return NextResponse.json({ error: WRONG_TYPE }, { status: 415 });

  let art;
  try {
    art = await storeSignInArt(buf);
  } catch (e) {
    if (e instanceof ArtworkError) return NextResponse.json({ error: e.message }, { status: 422 });
    console.error("[artwork] upload failed:", e);
    return NextResponse.json({ error: "Couldn't upload the image." }, { status: 500 });
  }

  await audit({
    actor: actorFrom(gate),
    action: "branding.artwork_uploaded",
    details: { width: art.width, height: art.height },
    ip: ipFrom(req),
  });
  return NextResponse.json({ version: art.version, width: art.width, height: art.height });
}

// Back to the default art drawn from the accent; the files are deleted.
export async function DELETE(req: Request) {
  const gate = await apiGuard("admin", "workspace.branding_manage");
  if (gate instanceof NextResponse) return gate;

  await removeSignInArt();
  await audit({ actor: actorFrom(gate), action: "branding.artwork_removed", ip: ipFrom(req) });
  return NextResponse.json({ ok: true });
}

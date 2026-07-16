import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getSetting, setSetting } from "@/lib/db";
import { saveUpload, deleteUpload } from "@/lib/uploads";
import { fetchFavicon } from "@/lib/favicon";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Workspace logo management: upload an image, or fetch a website's icon.
// Either way the image lands in the uploads volume and logo_url points at the
// public /api/brand/logo route (with a per-file cache-buster).

const ACCEPTED: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};
const MAX_BYTES = 1024 * 1024;

async function storeLogo(buf: Buffer, mime: string): Promise<string> {
  const stored = await saveUpload(buf, ACCEPTED[mime]);
  const old = await getSetting("logo_file");
  if (old) await deleteUpload(old);
  await setSetting("logo_file", stored);
  await setSetting("logo_mime", mime);
  const url = `/api/brand/logo?v=${stored.slice(0, 12)}`;
  await setSetting("logo_url", url);
  return url;
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const contentType = req.headers.get("content-type") || "";

  // Mode 1: multipart upload of a logo image.
  if (contentType.includes("multipart/form-data")) {
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
      return NextResponse.json({ error: "Logos are limited to 1 MB." }, { status: 413 });
    }
    const mime = (file.type || "").toLowerCase();
    if (!ACCEPTED[mime]) {
      return NextResponse.json(
        { error: "Use a PNG, JPEG, GIF, WebP, or ICO image." },
        { status: 415 }
      );
    }
    const url = await storeLogo(Buffer.from(await file.arrayBuffer()), mime);
    await audit({ actor: actorFrom(gate), action: "branding.logo_uploaded", ip: ipFrom(req) });
    return NextResponse.json({ logo_url: url });
  }

  // Mode 2: JSON { site_url } — fetch that website's icon.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const siteUrl = typeof body?.site_url === "string" ? body.site_url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(siteUrl.includes("://") ? siteUrl : `https://${siteUrl}`);
  } catch {
    return NextResponse.json({ error: "Enter a valid website URL." }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ error: "Enter a valid http(s) URL." }, { status: 400 });
  }

  const icon = await fetchFavicon(parsed.toString());
  if (!icon) {
    return NextResponse.json(
      { error: "Couldn't find a usable icon on that site — try uploading one instead." },
      { status: 422 }
    );
  }
  // fetchFavicon stored the file already; just point the settings at it.
  const old = await getSetting("logo_file");
  if (old) await deleteUpload(old);
  await setSetting("logo_file", icon.stored);
  await setSetting("logo_mime", icon.mime);
  const url = `/api/brand/logo?v=${icon.stored.slice(0, 12)}`;
  await setSetting("logo_url", url);

  await audit({
    actor: actorFrom(gate),
    action: "branding.logo_fetched",
    details: { site: parsed.origin },
    ip: ipFrom(req),
  });
  return NextResponse.json({ logo_url: url });
}

// Remove the stored logo (and clear logo_url if it pointed at it).
export async function DELETE(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const old = await getSetting("logo_file");
  if (old) await deleteUpload(old);
  await setSetting("logo_file", "");
  await setSetting("logo_mime", "");
  const current = (await getSetting("logo_url")) || "";
  if (current.startsWith("/api/brand/logo")) await setSetting("logo_url", "");

  await audit({ actor: actorFrom(gate), action: "branding.logo_removed", ip: ipFrom(req) });
  return NextResponse.json({ ok: true });
}

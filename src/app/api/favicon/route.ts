import { NextResponse } from "next/server";
import { Readable } from "stream";
import { apiGuard } from "@/lib/api-auth";
import { getSiteIcon, saveSiteIcon } from "@/lib/db";
import { fetchFavicon } from "@/lib/favicon";
import { uploadReadStream, uploadExists, deleteUpload } from "@/lib/uploads";

export const dynamic = "force-dynamic";

// Favicon proxy for external links in documents/newsletters: fetches a site's
// icon once (server-side), caches it in the uploads volume, and serves it from
// our origin. Signed-in users only, and only public-looking https hosts —
// this must not become an SSRF gadget against the internal network.

const RETRY_NEGATIVE_MS = 7 * 24 * 3600_000;

function validHost(host: string): boolean {
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(host)) {
    return false; // requires at least one dot: bare/internal names excluded
  }
  if (host.length > 253) return false;
  // No IP literals, and none of the common internal suffixes.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (/\.(local|internal|lan|home|corp|localdomain)$/.test(host)) return false;
  return true;
}

export async function GET(req: Request) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;

  const host = (new URL(req.url).searchParams.get("host") || "").trim().toLowerCase();
  if (!validHost(host)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let icon = await getSiteIcon(host);
  const stale =
    icon &&
    icon.stored_name === "" &&
    Date.now() - new Date(icon.fetched_at).getTime() > RETRY_NEGATIVE_MS;

  if (!icon || stale) {
    const fetched = await fetchFavicon(`https://${host}/`);
    await saveSiteIcon(host, fetched?.stored ?? "", fetched?.mime ?? "");
    icon = { host, stored_name: fetched?.stored ?? "", mime: fetched?.mime ?? "", fetched_at: "" };
  }

  if (!icon.stored_name || !(await uploadExists(icon.stored_name))) {
    if (icon.stored_name) {
      // Cached row points at a missing blob — drop it so a later request refetches.
      await saveSiteIcon(host, "", "");
      await deleteUpload(icon.stored_name);
    }
    return NextResponse.json({ error: "No icon." }, { status: 404 });
  }

  const stream = uploadReadStream(icon.stored_name);
  if (!stream) return NextResponse.json({ error: "No icon." }, { status: 404 });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": icon.mime || "image/x-icon",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400",
    },
  });
}

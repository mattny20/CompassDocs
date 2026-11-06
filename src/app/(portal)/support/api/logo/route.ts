// GET /support/api/logo   the portal's logo (Desk settings, Customer
//   portal), while the portal is open. Public: it is on the sign-in page.
//   Stored as an image the upload identified by its bytes (PNG, JPEG, GIF
//   or WebP); served with its sniffed type, nosniff.
// Customer portal (Helpdesk 1.19.1).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPortalSettings, portalNotFound, portalOpen } from "@/lib/helpdesk/portal";
import { isValidStoredName, sniffImage, uploadDir } from "@/lib/uploads";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getPortalSettings();
  if (!(await portalOpen(s)) || !s.brand_logo || !isValidStoredName(s.brand_logo)) return portalNotFound();
  let buf: Buffer;
  try {
    buf = await readFile(join(uploadDir(), s.brand_logo));
  } catch {
    return portalNotFound();
  }
  const img = sniffImage(buf);
  if (!img) return portalNotFound();
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": img.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

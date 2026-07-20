import { saveUpload } from "./uploads";

// Best-effort favicon fetcher for Quick links. Runs server-side when an admin
// saves a link with the "site icon" option: we pull the page, look for its
// declared icons, fall back to /favicon.ico, and cache the image in the
// uploads volume. Every failure is soft — the link just renders a letter tile.

// Image types we'll cache and serve inline. SVG is deliberately excluded
// (same policy as attachments: no script-capable formats on our origin).
const ICON_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8000;

function extToMime(url: string): string | null {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  return null;
}

async function fetchBytes(
  url: string,
  maxBytes: number
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    // SSRF-guarded: blocks metadata/link-local/loopback targets and
    // re-validates every redirect hop (see safe-fetch.ts).
    const { safeFetch } = await import("./safe-fetch");
    const res = await safeFetch(url, {
      headers: { "User-Agent": "CompassDocs link icon fetcher", Accept: "*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return {
      buf: Buffer.concat(chunks),
      contentType: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** Pull icon hrefs out of a page's <link rel="…icon…"> tags, best first. */
export function iconHrefsFromHtml(html: string, baseUrl: string): string[] {
  const out: { href: string; score: number }[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const rel = /rel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() || "";
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = /href\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    // Prefer big, modern icons: apple-touch-icon (usually 180px), then
    // declared sizes, then PNG over ICO.
    let score = 0;
    if (rel.includes("apple-touch-icon")) score += 100;
    const sizes = /sizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    if (sizes) score += Math.min(Number(sizes), 512) / 8;
    if (/\.png(\?|#|$)/i.test(href)) score += 10;
    if (/\.svg(\?|#|$)/i.test(href)) continue; // not served inline
    try {
      out.push({ href: new URL(href, baseUrl).toString(), score });
    } catch {
      /* bad href */
    }
  }
  return out.sort((a, b) => b.score - a.score).map((o) => o.href);
}

/**
 * Fetch + cache the site icon for `siteUrl`. Returns the stored upload name
 * and mime, or null when nothing usable could be retrieved.
 */
export async function fetchFavicon(
  siteUrl: string
): Promise<{ stored: string; mime: string } | null> {
  let origin: string;
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    origin = u.origin;
  } catch {
    return null;
  }

  const candidates: string[] = [];
  const page = await fetchBytes(siteUrl, MAX_HTML_BYTES);
  if (page && page.contentType.includes("html")) {
    candidates.push(...iconHrefsFromHtml(page.buf.toString("utf8"), siteUrl));
  }
  candidates.push(`${origin}/favicon.ico`);

  for (const url of candidates.slice(0, 5)) {
    const icon = await fetchBytes(url, MAX_ICON_BYTES);
    if (!icon || icon.buf.length === 0) continue;
    // Some servers send icons as text/plain or octet-stream — fall back to the
    // URL's extension before giving up on the candidate.
    const mime = ICON_MIME[icon.contentType] ? icon.contentType : extToMime(url);
    if (!mime || !ICON_MIME[mime]) continue;
    const stored = await saveUpload(icon.buf, ICON_MIME[mime]);
    return { stored, mime };
  }
  return null;
}

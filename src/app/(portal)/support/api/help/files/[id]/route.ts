// GET /support/api/help/files/[id]   a file a public help centre article
//   carries (its attachment list, an image, or a ::video's source and
//   poster in its body).
// Customer portal help centre (Helpdesk 1.19.4, C3). Public while the
// help centre is on; the file's own document must pass the help centre's
// rule (lib/helpdesk/help-centre publicArticleScope), else 404 like a file
// that does not exist. The four sniffed image types and videos inline,
// everything else as a download; always nosniff and a sandboxing CSP.
// Byte ranges (206 with Content-Range, 416 past the end) as the app's own
// attachment route serves them: Safari and iOS refuse to play a video
// without them.

import { Readable } from "stream";
import { helpCentreFile } from "@/lib/helpdesk/help-centre";
import { portalNotFound } from "@/lib/helpdesk/portal";
import { isInlineImage, isInlineVideo, uploadExists, uploadReadStream } from "@/lib/uploads";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const raw = (await params).id;
  const id = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
  const file = await helpCentreFile(id);
  if (!file || !(await uploadExists(file.stored_name))) return portalNotFound();
  const inline = isInlineImage(file.mime_type) || isInlineVideo(file.mime_type);
  const headers: Record<string, string> = {
    "Content-Type": inline ? file.mime_type : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=300",
    "Accept-Ranges": "bytes",
  };

  // "start-", "start-end", or the suffix form "-lastN" (one range only).
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get("range") ?? "").trim());
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, file.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1;
    if (!Number.isFinite(start) || start >= file.size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    }
    const part = uploadReadStream(file.stored_name, { start, end });
    if (!part) return portalNotFound();
    return new Response(Readable.toWeb(part) as unknown as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const stream = uploadReadStream(file.stored_name);
  if (!stream) return portalNotFound();
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: { ...headers, "Content-Length": String(file.size) },
  });
}

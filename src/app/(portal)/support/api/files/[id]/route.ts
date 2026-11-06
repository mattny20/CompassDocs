// GET /support/api/files/[id]   download a file from the contact's own
//   request: only one on a public message that was sent (never an internal
//   note's, never a held reply's). The four sniffed image types inline,
//   everything else as a download; always nosniff and a sandboxing CSP.
//   404 for anything else.
// Customer portal (Helpdesk 1.19.1).

import { Readable } from "stream";
import { contactAttachment, portalGate, portalNotFound } from "@/lib/helpdesk/portal";
import { isInlineImage, uploadExists, uploadReadStream } from "@/lib/uploads";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await portalGate(req);
  if (gate instanceof Response) return gate;
  const raw = (await params).id;
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  const att = await contactAttachment(gate.contact.id, id);
  if (!att || !(await uploadExists(att.stored_name))) return portalNotFound();
  const stream = uploadReadStream(att.stored_name);
  if (!stream) return portalNotFound();
  const inline = isInlineImage(att.mime_type);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": inline ? att.mime_type : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "Content-Length": String(att.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}

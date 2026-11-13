// GET /api/helpdesk/attachments/[id]   download a ticket's file.
//   Unbound: only its uploader. On a ticket: whoever may see the ticket
//   (requester, approver, agent who works it); a file on an internal note,
//   or on a reply held for review or returned (never sent): agents who work
//   the ticket only (and its uploader). Served as a download
//   (Content-Disposition: attachment) except the four sniffed image types,
//   always nosniff; byte ranges honoured.
// Helpdesk 1.19.0 (helpdesk.request). 404 for anything the caller may not read.

import { NextResponse } from "next/server";
import { Readable } from "stream";
import { mfaRequired } from "@/lib/api-auth";
import { canWorkTicket, deskDuoBarsTicket, helpdeskGate, ticketRelation } from "@/lib/helpdesk/access";
import { getAttachmentForDownload } from "@/lib/helpdesk/attachments";
import { getTicketRow } from "@/lib/helpdesk/tickets";
import { notFound } from "@/lib/helpdesk/routes";
import { isInlineImage, uploadExists, uploadReadStream } from "@/lib/uploads";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  const att = await getAttachmentForDownload(id);
  if (!att) return notFound();
  if (att.ticket_id === null) {
    if (att.uploaded_by !== gate.id) return notFound();
  } else {
    const t = await getTicketRow(att.ticket_id);
    if (!t) return notFound();
    const internal = att.message_kind === "internal";
    const unsent = att.message_review_state === "pending" || att.message_review_state === "returned";
    if (internal || unsent || att.message_id === null) {
      // Internal notes' files, files on a reply never sent, and files not
      // yet on a message: agents (and the uploader, for the last two).
      const uploader = att.uploaded_by === gate.id && (att.message_id === null || unsent);
      if (!(await canWorkTicket(gate, t)) && !uploader) return (await deskDuoBarsTicket(gate, t)) ? mfaRequired() : notFound();
    } else if (!(await ticketRelation(gate, t))) return (await deskDuoBarsTicket(gate, t)) ? mfaRequired() : notFound();
  }
  if (!(await uploadExists(att.stored_name))) return notFound();

  const inline = isInlineImage(att.type);
  const headers: Record<string, string> = {
    "Content-Type": inline ? att.type : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.get("range") ?? "").trim());
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, att.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), att.size - 1) : att.size - 1;
    if (!Number.isFinite(start) || start >= att.size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${att.size}` } });
    }
    const partial = uploadReadStream(att.stored_name, { start, end });
    if (!partial) return notFound();
    return new Response(Readable.toWeb(partial) as unknown as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${att.size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = uploadReadStream(att.stored_name);
  if (!stream) return notFound();
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: { ...headers, "Content-Length": String(att.size) },
  });
}

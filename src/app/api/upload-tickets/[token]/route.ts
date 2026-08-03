import { NextResponse } from "next/server";
import {
  getUploadTicket,
  ticketState,
  claimUploadTicket,
  validateImage,
  storeImage,
  withImagePlaced,
} from "@/lib/image-intake";
import { getDocument, getUserById, updateDocument } from "@/lib/db";
import { audit, ipFrom } from "@/lib/audit";
import { uploadTicketRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// The receiving end of a drop link. Deliberately unauthenticated: the whole
// point is that the person holding the picture may not be signed in on the
// device that has it — they are looking at a screenshot on their phone while
// the assistant runs on their laptop.
//
// What makes that safe is how narrow the ticket is. It was minted by someone
// who already had edit rights on that one document; it carries 24 random bytes;
// it survives an hour; it works exactly once (the claim is an atomic UPDATE);
// and the only thing it can do is add one image to that one document. The
// upload is attributed to the user who minted it, and audited as such — this
// link is that person's hands, not a new principal.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (uploadTicketRateLimited(ipFrom(req) || "anon")) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }

  const ticket = await getUploadTicket(token);
  const state = ticketState(ticket);
  if (state !== "ok" || !ticket) {
    return NextResponse.json({ error: LINK_MESSAGE[state] }, { status: state === "unknown" ? 404 : 410 });
  }

  const doc = await getDocument(ticket.document_id);
  if (!doc) return NextResponse.json({ error: "That document no longer exists." }, { status: 410 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }

  // Same validator as every other intake — the bytes decide the type, so a
  // renamed .png that is really a PDF is refused here rather than rendering as
  // a broken image in the document.
  const intake = await validateImage(Buffer.from(await file.arrayBuffer()));
  if (!intake.ok) return NextResponse.json({ error: intake.error }, { status: 400 });

  const att = await storeImage({
    documentId: doc.id,
    userId: ticket.created_by,
    buf: intake.buf,
    kind: intake.kind,
    filename: file.name,
  });

  // Claim before placing. If two drops race, only one wins the UPDATE; the
  // loser has already written an attachment, which is harmless clutter, but it
  // must not also edit the document body a second time.
  const claimed = await claimUploadTicket(token, att.id);
  if (!claimed) {
    return NextResponse.json({ error: LINK_MESSAGE.used }, { status: 410 });
  }

  const alt = ticket.alt.trim() || att.filename;
  const markdown = `![${alt}](/api/attachments/${att.id})`;
  let placed = false;
  if (ticket.insert_mode !== "none") {
    const fresh = await getDocument(doc.id);
    if (fresh) {
      await updateDocument(doc.id, {
        content: withImagePlaced(fresh.content, markdown, ticket.insert_mode),
      });
      placed = true;
    }
  }

  const owner = await getUserById(ticket.created_by);
  await audit({
    actor: owner ? { id: owner.id, name: owner.name || owner.username, role: owner.role } : { name: "system" },
    action: "attachment.upload",
    targetType: "document",
    targetId: doc.id,
    targetLabel: doc.title,
    details: {
      via: "upload-link",
      filename: att.filename,
      size: intake.buf.length,
      mime: intake.kind.mime,
      inserted: placed,
    },
    ip: ipFrom(req),
  });

  return NextResponse.json({
    ok: true,
    inserted: placed,
    document: { id: doc.id, title: doc.title },
    url: `/api/attachments/${att.id}`,
  });
}

const LINK_MESSAGE: Record<"ok" | "unknown" | "expired" | "used", string> = {
  ok: "",
  unknown: "That link isn't valid. Ask for a new one.",
  expired: "That link has expired. Ask for a new one — they last an hour.",
  used: "That link has already been used. Ask for a new one.",
};

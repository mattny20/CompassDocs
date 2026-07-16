import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  setNewsletterStatus,
  addNewsletterComment,
  getUserById,
} from "@/lib/db";
import { canDecide } from "@/lib/newsletter-access";
import { sendWorkflowNotice } from "@/lib/newsletter";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The approver's verdict on an in-review newsletter: approve it for sending,
// or send it back to the author with comments (changes_requested).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);
  if (!canDecide(user, n, approverIds)) {
    return NextResponse.json({ error: "You can't review this newsletter." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = body?.action === "approve" ? "approve" : body?.action === "request_changes" ? "request_changes" : "";
  if (!action) {
    return NextResponse.json({ error: "action must be approve or request_changes." }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 5000) : "";
  if (action === "request_changes" && !note) {
    return NextResponse.json(
      { error: "Tell the author what to change — a note is required." },
      { status: 400 }
    );
  }

  const nextStatus = action === "approve" ? "approved" : "changes_requested";
  const updated = await setNewsletterStatus(n.id, nextStatus);
  const reviewerName = user.name || user.username;
  await addNewsletterComment({
    newsletter_id: n.id,
    user_id: user.id,
    author_name: reviewerName,
    body: note || "Approved for sending.",
    kind: action === "approve" ? "approved" : "changes_requested",
  });

  // Let the author know (best-effort; skips silently when SMTP is off).
  if (n.created_by && n.created_by !== user.id) {
    const author = await getUserById(n.created_by);
    if (author?.email) {
      const origin = requestOrigin(req);
      await sendWorkflowNotice(
        [author.email],
        action === "approve"
          ? `Approved: ${n.subject}`
          : `Changes requested: ${n.subject}`,
        `${reviewerName} ${action === "approve" ? "approved" : "requested changes to"} your newsletter "${n.subject}".` +
          (note ? `\n\n${note}` : "") +
          (origin ? `\n\nOpen it here: ${origin}/newsletter/${n.id}` : "")
      );
    }
  }

  await audit({
    actor: actorFrom(user),
    action: action === "approve" ? "newsletter.approved" : "newsletter.changes_requested",
    targetType: "newsletter",
    targetId: n.id,
    targetLabel: n.subject,
    details: note ? { note } : undefined,
    ip: ipFrom(req),
  });
  return NextResponse.json({ newsletter: updated });
}

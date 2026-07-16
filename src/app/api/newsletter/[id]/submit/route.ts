import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  setNewsletterStatus,
  addNewsletterComment,
  listNewsletterApproverPool,
} from "@/lib/db";
import { canSubmit } from "@/lib/newsletter-access";
import { sendWorkflowNotice } from "@/lib/newsletter";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Author hands the draft to the approvers: draft/changes_requested -> in_review.
// In-scope approvers get a best-effort email pointing at the review page.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  if (!canSubmit(user, n)) {
    return NextResponse.json({ error: "This newsletter can't be submitted for review." }, { status: 403 });
  }
  if (!n.subject.trim()) {
    return NextResponse.json({ error: "Give the newsletter a subject first." }, { status: 400 });
  }
  if (!n.body.trim()) {
    return NextResponse.json({ error: "The newsletter is empty." }, { status: 400 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 2000) : "";

  const updated = await setNewsletterStatus(n.id, "in_review");
  const authorName = user.name || user.username;
  await addNewsletterComment({
    newsletter_id: n.id,
    user_id: user.id,
    author_name: authorName,
    body: note || "Submitted for review.",
    kind: "submitted",
  });

  // Notify the approvers in scope (override list if set, else the whole pool),
  // minus the submitter themselves.
  const pool = await listNewsletterApproverPool();
  const override = await getNewsletterApproverIds(n.id);
  const inScope = override.length > 0 ? pool.filter((u) => override.includes(u.id)) : pool;
  const origin = requestOrigin(req);
  await sendWorkflowNotice(
    inScope.filter((u) => u.id !== user.id && u.email).map((u) => u.email),
    `Review requested: ${n.subject}`,
    `${authorName} submitted the newsletter "${n.subject}" for review.` +
      (note ? `\n\nNote from the author:\n${note}` : "") +
      (origin ? `\n\nReview it here: ${origin}/newsletter/${n.id}` : "")
  );

  await audit({
    actor: actorFrom(user),
    action: "newsletter.submitted",
    targetType: "newsletter",
    targetId: n.id,
    targetLabel: n.subject,
    ip: ipFrom(req),
  });
  return NextResponse.json({ newsletter: updated });
}

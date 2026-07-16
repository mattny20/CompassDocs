import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  setNewsletterSchedule,
  addNewsletterComment,
} from "@/lib/db";
import { canSend } from "@/lib/newsletter-access";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Schedule (or unschedule, with at: null) the send of an approved newsletter.
// The in-app sweeper delivers it within a minute of the chosen time.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);
  if (!canSend(user, n, approverIds)) {
    return NextResponse.json(
      { error: "Only an approver can schedule, and only once the newsletter is approved." },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const actorName = user.name || user.username;

  if (body?.at === null) {
    const updated = await setNewsletterSchedule(n.id, null, "");
    await addNewsletterComment({
      newsletter_id: n.id,
      user_id: user.id,
      author_name: actorName,
      body: "Cancelled the scheduled send.",
      kind: "comment",
    });
    await audit({
      actor: actorFrom(user),
      action: "newsletter.unscheduled",
      targetType: "newsletter",
      targetId: n.id,
      targetLabel: n.subject,
      ip: ipFrom(req),
    });
    return NextResponse.json({ newsletter: updated });
  }

  const at = new Date(String(body?.at ?? ""));
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json({ error: "Pick a valid date and time." }, { status: 400 });
  }
  if (at.getTime() < Date.now() + 60_000) {
    return NextResponse.json(
      { error: "Pick a time at least a minute in the future — or just press Send." },
      { status: 400 }
    );
  }
  if (at.getTime() > Date.now() + 365 * 24 * 3600_000) {
    return NextResponse.json({ error: "Schedules are limited to one year out." }, { status: 400 });
  }

  const updated = await setNewsletterSchedule(n.id, at.toISOString(), requestOrigin(req));
  await addNewsletterComment({
    newsletter_id: n.id,
    user_id: user.id,
    author_name: actorName,
    body: `Scheduled to send ${at.toLocaleString()}.`,
    kind: "scheduled",
  });
  await audit({
    actor: actorFrom(user),
    action: "newsletter.scheduled",
    targetType: "newsletter",
    targetId: n.id,
    targetLabel: n.subject,
    details: { at: at.toISOString() },
    ip: ipFrom(req),
  });
  return NextResponse.json({ newsletter: updated });
}

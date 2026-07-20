import { NextResponse } from "next/server";
import { getDocument } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { canEditSpace } from "@/lib/access";
import { setReviewSchedule, markReviewed, REVIEW_INTERVALS } from "@/lib/reviews";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function guard(id: string) {
  const gate = await apiGuard("editor");
  if (gate instanceof NextResponse) return { gate };
  const user = gate as SessionUser;
  const doc = await getDocument(Number(id));
  if (!doc || doc.branch_of !== null) {
    return { gate: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  if (!(await canEditSpace(user, doc.space_id))) {
    return {
      gate: NextResponse.json({ error: "You don't have edit access to this space." }, { status: 403 }),
    };
  }
  return { user, doc };
}

// Set or clear the review schedule.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard((await params).id);
  if ("gate" in g) return g.gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const interval = body?.interval_days === null ? null : Number(body?.interval_days);
  if (interval !== null && !REVIEW_INTERVALS.includes(interval)) {
    return NextResponse.json(
      { error: `interval_days must be null or one of: ${REVIEW_INTERVALS.join(", ")}.` },
      { status: 400 }
    );
  }
  await setReviewSchedule(g.doc.id, interval);
  await audit({
    actor: actorFrom(g.user),
    action: "document.review_schedule",
    targetType: "document",
    targetId: g.doc.id,
    targetLabel: g.doc.title,
    details: { interval_days: interval },
    ip: ipFrom(req),
  });
  const doc = await getDocument(g.doc.id);
  return NextResponse.json({
    ok: true,
    review_interval_days: doc?.review_interval_days ?? null,
    review_due_at: doc?.review_due_at ?? null,
  });
}

// Mark the document as reviewed: the due date moves a full interval out.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard((await params).id);
  if ("gate" in g) return g.gate;

  const reviewer = g.user.name || g.user.username;
  const ok = await markReviewed(g.doc.id, reviewer);
  if (!ok) {
    return NextResponse.json({ error: "This document has no review schedule." }, { status: 400 });
  }
  await audit({
    actor: actorFrom(g.user),
    action: "document.reviewed",
    targetType: "document",
    targetId: g.doc.id,
    targetLabel: g.doc.title,
    ip: ipFrom(req),
  });
  const doc = await getDocument(g.doc.id);
  return NextResponse.json({ ok: true, review_due_at: doc?.review_due_at ?? null });
}

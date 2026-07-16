import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getNewsletter,
  getNewsletterApproverIds,
  updateNewsletterContent,
  setNewsletterApprovers,
  listNewsletterApproverPool,
  listNewsletterComments,
  deleteNewsletter,
} from "@/lib/db";
import {
  canView,
  canUseNewsletter,
  canEditContent,
  canSubmit,
  canDecide,
  canSend,
  canComment,
  canDelete,
  canApprove,
  isAuthor,
} from "@/lib/newsletter-access";
import { listNewsletterFromAddresses } from "@/lib/newsletter";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);
  if (!canView(user, n, approverIds)) {
    return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  }

  return NextResponse.json({
    newsletter: n,
    // The editorial thread stays with the editorial crew — a sent newsletter
    // is readable by everyone, but its review history isn't.
    comments: canUseNewsletter(user) ? await listNewsletterComments(n.id) : [],
    approver_ids: approverIds,
    can: {
      edit: canEditContent(user, n, approverIds),
      submit: canSubmit(user, n),
      decide: canDecide(user, n, approverIds),
      send: canSend(user, n, approverIds),
      comment: canComment(user, n, approverIds),
      delete: canDelete(user, n),
    },
  });
}

// Content edits (author until approved; in-scope approvers/admins until sent)
// and the approver override list (author while drafting, admins any time).
export async function PATCH(req: Request, { params }: Params) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let updated = n;
  const wantsContent =
    typeof body?.subject === "string" ||
    typeof body?.body === "string" ||
    typeof body?.mode === "string" ||
    typeof body?.from_address === "string" ||
    Array.isArray(body?.group_ids);
  if (wantsContent) {
    if (!canEditContent(user, n, approverIds)) {
      return NextResponse.json({ error: "You can't edit this newsletter." }, { status: 403 });
    }
    const groupIds: number[] = Array.isArray(body?.group_ids)
      ? body.group_ids.map(Number).filter((x: number) => Number.isInteger(x) && x > 0)
      : (n.group_ids || "").split(",").map(Number).filter(Boolean);
    // The sender must come from the admin-curated list (or '' = SMTP default).
    let fromAddress = n.from_address;
    if (typeof body?.from_address === "string") {
      const wanted = body.from_address.trim();
      if (wanted === "" || (await listNewsletterFromAddresses()).includes(wanted)) {
        fromAddress = wanted;
      } else {
        return NextResponse.json(
          { error: "Pick a From address from the list an admin has configured." },
          { status: 400 }
        );
      }
    }
    updated =
      (await updateNewsletterContent(n.id, {
        subject: typeof body?.subject === "string" ? body.subject : n.subject,
        body: typeof body?.body === "string" ? body.body : n.body,
        mode: typeof body?.mode === "string" ? body.mode : n.mode,
        group_ids: groupIds.join(","),
        from_address: fromAddress,
      })) ?? n;
  }

  if (Array.isArray(body?.approver_ids)) {
    const mayAssign =
      user.role === "admin" ||
      (isAuthor(user, n) && (n.status === "draft" || n.status === "changes_requested")) ||
      canApprove(user, approverIds);
    if (!mayAssign || n.status === "sent") {
      return NextResponse.json({ error: "You can't change the approver list." }, { status: 403 });
    }
    const pool = new Set((await listNewsletterApproverPool()).map((u) => u.id));
    const ids = body.approver_ids
      .map(Number)
      .filter((x: number) => Number.isInteger(x) && x > 0 && pool.has(x));
    await setNewsletterApprovers(n.id, ids);
  }

  return NextResponse.json({
    newsletter: updated,
    approver_ids: await getNewsletterApproverIds(n.id),
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  if (!canDelete(user, n)) {
    return NextResponse.json({ error: "You can't delete this newsletter." }, { status: 403 });
  }
  await deleteNewsletter(n.id);
  await audit({
    actor: actorFrom(user),
    action: "newsletter.deleted",
    targetType: "newsletter",
    targetId: n.id,
    targetLabel: n.subject || "(untitled)",
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

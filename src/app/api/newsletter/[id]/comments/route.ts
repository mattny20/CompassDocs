import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getNewsletter, getNewsletterApproverIds, addNewsletterComment } from "@/lib/db";
import { canComment } from "@/lib/newsletter-access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Discussion on an unsent newsletter: the author and in-scope approvers can
// trade comments/suggestions; workflow events land in the same thread.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);
  if (!canComment(user, n, approverIds)) {
    return NextResponse.json({ error: "You can't comment on this newsletter." }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return NextResponse.json({ error: "The comment is empty." }, { status: 400 });

  const comment = await addNewsletterComment({
    newsletter_id: n.id,
    user_id: user.id,
    author_name: user.name || user.username,
    body: text,
    kind: "comment",
  });
  return NextResponse.json({ comment }, { status: 201 });
}

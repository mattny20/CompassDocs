import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { join } from "path";
import {
  getNewsletter,
  getNewsletterApproverIds,
  markNewsletterSent,
  addNewsletterComment,
  getUserById,
  listGroups,
  listNewsletterFiles,
} from "@/lib/db";
import { uploadDir } from "@/lib/uploads";
import { canSend, canComment } from "@/lib/newsletter-access";
import { sendNewsletter, archiveNewsletter } from "@/lib/newsletter";
import { getAppSettings } from "@/lib/settings-store";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// The real send (approved newsletters, in-scope approvers/admins only) or a
// test send to the caller's own inbox (anyone participating, any unsent state).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const { id } = await params;
  const n = await getNewsletter(Number(id));
  if (!n) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  const approverIds = await getNewsletterApproverIds(n.id);

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const isTest = body?.test === true;

  if (isTest) {
    if (n.status === "sent" || !canComment(user, n, approverIds)) {
      return NextResponse.json({ error: "You can't test-send this newsletter." }, { status: 403 });
    }
  } else if (!canSend(user, n, approverIds)) {
    return NextResponse.json(
      { error: "Only an approver can send, and only once the newsletter is approved." },
      { status: 403 }
    );
  }
  if (!n.subject.trim() || !n.body.trim()) {
    return NextResponse.json({ error: "The newsletter needs a subject and content." }, { status: 400 });
  }

  const settings = await getAppSettings();
  const attachments = (await listNewsletterFiles(n.id)).map((f) => ({
    filename: f.filename,
    path: join(uploadDir(), f.stored_name),
  }));
  const base = {
    subject: n.subject,
    markdown: n.body,
    orgName: settings.company_name || "CompassDocs",
    logoUrl: settings.logo_url || "",
    accent: settings.accent_color || "#2e75bd",
    origin: requestOrigin(req),
    authorName: n.author_name,
    from: n.from_address || undefined,
    attachments,
  };

  if (isTest) {
    const me = await getUserById(user.id);
    if (!me?.email) {
      return NextResponse.json({ error: "Your account has no email address." }, { status: 400 });
    }
    const r = await sendNewsletter({ ...base, to: { emails: [me.email] } });
    if (r.error) return NextResponse.json({ error: r.error }, { status: 422 });
    return NextResponse.json({ test: true, sent: r.sent });
  }

  const groupIds = (n.group_ids || "").split(",").map(Number).filter(Boolean);
  if (n.mode === "groups" && groupIds.length === 0) {
    return NextResponse.json({ error: "Pick at least one group, or send to everyone." }, { status: 400 });
  }
  const r = await sendNewsletter({ ...base, to: n.mode === "groups" ? groupIds : "all" });
  if (r.error) return NextResponse.json({ error: r.error }, { status: 422 });

  let audience = "Everyone";
  if (n.mode === "groups") {
    const names = (await listGroups())
      .filter((g) => groupIds.includes(g.id))
      .map((g) => g.name);
    audience = `Groups: ${names.join(", ") || groupIds.join(", ")}`;
  }
  await markNewsletterSent(n.id, audience, r.sent);
  await addNewsletterComment({
    newsletter_id: n.id,
    user_id: user.id,
    author_name: user.name || user.username,
    body: `Sent to ${audience.toLowerCase() === "everyone" ? "everyone" : audience} — ${r.sent} ${r.sent === 1 ? "recipient" : "recipients"}.`,
    kind: "sent",
  });
  const archivedDocId = await archiveNewsletter(n);
  if (archivedDocId) {
    await addNewsletterComment({
      newsletter_id: n.id,
      user_id: null,
      author_name: "Archive",
      body: `Filed in the archive space as document #${archivedDocId}.`,
      kind: "comment",
    });
  }

  await audit({
    actor: actorFrom(user),
    action: "newsletter.sent",
    targetType: "newsletter",
    targetId: n.id,
    targetLabel: n.subject,
    details: { audience, sent: r.sent },
    ip: ipFrom(req),
  });
  return NextResponse.json({ newsletter: await getNewsletter(n.id), sent: r.sent });
}

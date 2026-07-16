import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listNewsletters, recordNewsletter, getUserById } from "@/lib/db";
import { sendNewsletter } from "@/lib/newsletter";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { getAppSettings } from "@/lib/settings-store";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({
    newsletters: await listNewsletters(),
    smtpReady: smtpConfigured(await getSmtpConfig()),
  });
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const markdown = typeof body?.body === "string" ? body.body.trim() : "";
  if (!subject) return NextResponse.json({ error: "A subject is required." }, { status: 400 });
  if (!markdown) return NextResponse.json({ error: "The newsletter is empty." }, { status: 400 });

  const mode = body?.mode === "groups" ? "groups" : "all";
  const groupIds: number[] = Array.isArray(body?.group_ids)
    ? body.group_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (mode === "groups" && groupIds.length === 0 && body?.test !== true) {
    return NextResponse.json({ error: "Pick at least one group, or send to everyone." }, { status: 400 });
  }

  const settings = await getAppSettings();
  const authorName = user.name || user.username;
  const base = {
    subject,
    markdown,
    orgName: settings.company_name || "CompassDocs",
    logoUrl: settings.logo_url || "",
    accent: settings.accent_color || "#2e75bd",
    origin: requestOrigin(req),
    authorName,
  };

  // Test send: just to the composer's own address, never recorded.
  if (body?.test === true) {
    const me = await getUserById(user.id);
    if (!me?.email) {
      return NextResponse.json({ error: "Your account has no email address." }, { status: 400 });
    }
    const r = await sendNewsletter({ ...base, to: { emails: [me.email] } });
    if (r.error) return NextResponse.json({ error: r.error }, { status: 422 });
    return NextResponse.json({ test: true, sent: r.sent });
  }

  const r = await sendNewsletter({ ...base, to: mode === "all" ? "all" : groupIds });
  if (r.error) return NextResponse.json({ error: r.error }, { status: 422 });

  const audience = mode === "all" ? "Everyone" : `Groups: ${groupIds.join(", ")}`;
  const newsletter = await recordNewsletter({
    subject,
    body: markdown,
    author_name: authorName,
    created_by: user.id,
    audience,
    sent_count: r.sent,
  });

  await audit({
    actor: actorFrom(user),
    action: "newsletter.sent",
    targetType: "newsletter",
    targetId: newsletter.id,
    targetLabel: subject,
    details: { audience, sent: r.sent },
    ip: ipFrom(req),
  });
  return NextResponse.json({ newsletter, sent: r.sent }, { status: 201 });
}

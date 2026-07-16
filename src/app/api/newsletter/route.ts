import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  createNewsletterDraft,
  listNewslettersFor,
  listGroups,
  listNewsletterApproverPool,
  setNewsletterApprovers,
} from "@/lib/db";
import { canUseNewsletter, isNewsletterApprover } from "@/lib/newsletter-access";
import { listNewsletterFromAddresses } from "@/lib/newsletter";
import { getSmtpConfig, smtpConfigured } from "@/lib/smtp-config";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_ACCESS = { error: "You don't have newsletter access." };

export async function GET() {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!canUseNewsletter(user)) return NextResponse.json(NO_ACCESS, { status: 403 });

  return NextResponse.json({
    newsletters: await listNewslettersFor(user.id, isNewsletterApprover(user)),
    groups: (await listGroups()).map((g) => ({ id: g.id, name: g.name, member_count: g.member_count })),
    approverPool: await listNewsletterApproverPool(),
    fromAddresses: await listNewsletterFromAddresses(),
    smtpReady: smtpConfigured(await getSmtpConfig()),
  });
}

// Create a draft. Subject/body may still be empty at this point — they're
// required at submit time, not while the author is getting started.
export async function POST(req: Request) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!canUseNewsletter(user)) return NextResponse.json(NO_ACCESS, { status: 403 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const groupIds: number[] = Array.isArray(body?.group_ids)
    ? body.group_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  const newsletter = await createNewsletterDraft({
    subject: typeof body?.subject === "string" ? body.subject : "",
    body: typeof body?.body === "string" ? body.body : "",
    author_name: user.name || user.username,
    created_by: user.id,
    mode: body?.mode === "groups" ? "groups" : "all",
    group_ids: groupIds.join(","),
  });

  const approverIds: number[] = Array.isArray(body?.approver_ids)
    ? body.approver_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (approverIds.length > 0) {
    const pool = new Set((await listNewsletterApproverPool()).map((u) => u.id));
    await setNewsletterApprovers(newsletter.id, approverIds.filter((id) => pool.has(id)));
  }

  await audit({
    actor: actorFrom(user),
    action: "newsletter.created",
    targetType: "newsletter",
    targetId: newsletter.id,
    targetLabel: newsletter.subject || "(untitled)",
    ip: ipFrom(req),
  });
  return NextResponse.json({ newsletter }, { status: 201 });
}

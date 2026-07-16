import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { createAnnouncement, listAllAnnouncements } from "@/lib/db";
import { emailAnnouncement } from "@/lib/announcements";
import { notifyWebhooks } from "@/lib/webhooks";
import { getAppSettings } from "@/lib/settings-store";
import { requestOrigin } from "@/lib/oauth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const LEVELS = ["info", "warning", "critical"] as const;

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ announcements: await listAllAnnouncements() });
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

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const message = typeof body?.body === "string" ? body.body.trim() : "";
  if (!title) return NextResponse.json({ error: "A title is required." }, { status: 400 });
  if (!message) return NextResponse.json({ error: "A message is required." }, { status: 400 });
  const level = LEVELS.includes(body?.level) ? body.level : "info";
  const expiresDays = Number.isInteger(body?.expires_days) && body.expires_days > 0
    ? Math.min(body.expires_days, 365)
    : 0;

  // Email targeting: "none" (default) | "all" | "groups" with group_ids.
  // Whatever is chosen here, the dashboard block shows for every user.
  const emailMode = ["none", "all", "groups"].includes(body?.email_mode) ? body.email_mode : "none";
  const groupIds: number[] = Array.isArray(body?.email_group_ids)
    ? body.email_group_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (emailMode === "groups" && groupIds.length === 0) {
    return NextResponse.json(
      { error: "Pick at least one group, or choose Everyone / no email." },
      { status: 400 }
    );
  }

  const authorName = user.name || user.username;
  const announcement = await createAnnouncement({
    title,
    body: message,
    level,
    author_name: authorName,
    created_by: user.id,
    expires_days: expiresDays,
  });

  const settings = await getAppSettings();
  const origin = requestOrigin(req);

  if (body?.notify_webhooks === true) {
    void notifyWebhooks("announcement.posted", {
      title,
      actor: authorName,
      note: message,
      url: origin ? `${origin}/` : undefined,
    });
  }

  let emailed = 0;
  if (emailMode !== "none") {
    ({ sent: emailed } = await emailAnnouncement({
      title,
      body: message,
      level,
      authorName,
      orgName: settings.company_name || "CompassDocs",
      groupIds: emailMode === "all" ? "all" : groupIds,
      origin,
    }));
  }

  await audit({
    actor: actorFrom(user),
    action: "announcement.posted",
    targetType: "announcement",
    targetId: announcement.id,
    targetLabel: title,
    details: { level, emailMode, emailed, webhooks: body?.notify_webhooks === true },
    ip: ipFrom(req),
  });
  return NextResponse.json({ announcement, emailed }, { status: 201 });
}

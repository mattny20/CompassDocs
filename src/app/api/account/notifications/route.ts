import { NextResponse } from "next/server";
import {
  getUserById,
  listSubscriptionsForUser,
  setEmailNotifications,
  setNotifyWebhookUrl,
  setWeeklyDigest,
  getWeeklyDigest,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const [me, subscriptions] = await Promise.all([
    getUserById(user.id),
    listSubscriptionsForUser(user.id),
  ]);
  return NextResponse.json({
    email: me?.email ?? "",
    email_notifications: me?.email_notifications === 1,
    notify_webhook_url: me?.notify_webhook_url ?? "",
    weekly_digest: await getWeeklyDigest(user.id),
    subscriptions,
  });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body?.email_notifications === "boolean") {
    await setEmailNotifications(user.id, body.email_notifications);
  }
  if (typeof body?.weekly_digest === "boolean") {
    await setWeeklyDigest(user.id, body.weekly_digest);
  }
  if (typeof body?.notify_webhook_url === "string") {
    const url = body.notify_webhook_url.trim().slice(0, 500);
    if (url && !/^https:\/\//.test(url)) {
      return NextResponse.json(
        { error: "Webhook URL must start with https://." },
        { status: 400 }
      );
    }
    await setNotifyWebhookUrl(user.id, url);
  }
  return NextResponse.json({ ok: true });
}

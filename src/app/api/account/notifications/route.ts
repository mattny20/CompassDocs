import { NextResponse } from "next/server";
import {
  getUserById,
  listSubscriptionsForUser,
  setEmailNotifications,
  setNotifyWebhookUrl,
  setNotifyPrefs,
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
    notify_prefs: me?.notify_prefs ?? {},
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
  if (body?.notify_prefs !== undefined) {
    const cleaned = cleanNotifyPrefs(body.notify_prefs);
    if (cleaned === null) {
      return NextResponse.json({ error: "Invalid notification preferences." }, { status: 400 });
    }
    await setNotifyPrefs(user.id, cleaned);
  }
  return NextResponse.json({ ok: true });
}

const PREF_KINDS = [
  "mention",
  "comment",
  "doc_update",
  "cr_submitted",
  "cr_resolved",
  "review_due",
  "ack_requested",
];
const PREF_CHANNELS = ["inapp", "webhook", "email"];

/** Keep only known kind/channel keys with explicit `false` values — "on" is
 * the default, so the stored object stays a sparse list of opt-outs. */
function cleanNotifyPrefs(raw: unknown): Record<string, Record<string, boolean>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, Record<string, boolean>> = {};
  for (const [kind, channels] of Object.entries(raw)) {
    if (!PREF_KINDS.includes(kind)) return null;
    if (typeof channels !== "object" || channels === null || Array.isArray(channels)) return null;
    for (const [ch, val] of Object.entries(channels as object)) {
      if (!PREF_CHANNELS.includes(ch) || typeof val !== "boolean") return null;
      if (val === false) (out[kind] ??= {})[ch] = false;
    }
  }
  return out;
}

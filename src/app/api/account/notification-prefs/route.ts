// Account → Notifications (1.19.0): the signed-in person's notification
// preferences. GET returns their prefs (the saved row, or what their
// pre-1.19 settings say), the workspace policy as it applies to them and
// the effective answer per event and channel; PUT saves the whole prefs
// object (validated strictly; choices the workspace locked are dropped)
// and/or a pause preset, and mirrors the result into the pre-1.19 columns.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import type { SessionUser } from "@/lib/types";
import {
  effectiveMatrix,
  getNotifyPolicy,
  getUserNotifyPrefs,
  policyView,
  saveUserNotifyPrefs,
} from "@/lib/notify-policy";
import {
  pauseForPreset,
  resolveUserPrefs,
  userPrefsProblem,
  type PausePreset,
} from "@/lib/notify-policy-shared";

export const dynamic = "force-dynamic";

const MAX_BODY = 32 * 1024;
const PRESETS: PausePreset[] = ["1h", "tomorrow", "week", "indefinite", "off"];

async function view(userId: number) {
  const [mine, policy, effective] = await Promise.all([getUserNotifyPrefs(userId), getNotifyPolicy(), effectiveMatrix(userId)]);
  return {
    prefs: mine?.prefs ?? resolveUserPrefs(null),
    stored: mine?.stored ?? false,
    time_zone: mine?.timeZone ?? "UTC",
    policy: policyView(policy),
    effective,
  };
}

export async function GET() {
  const gate = await apiGuard("viewer", "account.notification_prefs_read");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  return NextResponse.json(await view(user.id));
}

export async function PUT(req: Request) {
  const gate = await apiGuard("viewer", "account.notification_prefs_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Those preferences are too large." }, { status: 413 });
  let body: { prefs?: unknown; pause?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || (body.prefs === undefined && body.pause === undefined)) {
    return NextResponse.json({ error: "Send your preferences or a pause." }, { status: 400 });
  }
  if (body.prefs !== undefined) {
    const problem = userPrefsProblem(body.prefs);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }
  if (body.pause !== undefined && !PRESETS.includes(body.pause as PausePreset)) {
    return NextResponse.json({ error: "Pause for an hour, until tomorrow, for a week, until you resume, or not at all." }, { status: 400 });
  }

  const current = await getUserNotifyPrefs(user.id);
  if (!current) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const next = body.prefs !== undefined ? resolveUserPrefs(body.prefs) : current.prefs;
  if (body.pause !== undefined) next.pause = pauseForPreset(body.pause as PausePreset, new Date(), current.timeZone);
  await saveUserNotifyPrefs(user.id, next);
  return NextResponse.json(await view(user.id));
}

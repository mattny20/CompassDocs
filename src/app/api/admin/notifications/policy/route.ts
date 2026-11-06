// Settings → Notifications → Policies (1.19.0): the workspace notification
// policy. GET returns the stored policy, the catalog and the effective cell
// for every event and channel; PUT replaces the policy (validated strictly,
// stored compacted) and audits notification.policy_updated with the events
// that changed. Same-origin and permission checks come from apiGuard.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";
import {
  changedPolicyEvents,
  getNotifyPolicy,
  notificationEventCatalog,
  policyView,
  saveNotifyPolicy,
} from "@/lib/notify-policy";
import { policyProblem, resolvePolicy } from "@/lib/notify-policy-shared";

export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

export async function GET() {
  const gate = await apiGuard("admin", "notification.policy_read");
  if (gate instanceof NextResponse) return gate;
  const policy = await getNotifyPolicy();
  return NextResponse.json({ policy, effective: policyView(policy), catalog: notificationEventCatalog() });
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin", "notification.policy_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "That policy is too large." }, { status: 413 });
  let body: { policy?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const problem = policyProblem(body?.policy);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const before = await getNotifyPolicy();
  const stored = await saveNotifyPolicy(resolvePolicy(body.policy));
  const changed = changedPolicyEvents(before, stored);
  if (changed.length > 0) {
    await audit({
      actor: actorFrom(user),
      action: "notification.policy_updated",
      targetType: "settings",
      targetId: "notification_policy",
      targetLabel: "Notification policy",
      details: { events: changed.slice(0, 100), before: pick(before, changed), after: pick(stored, changed) },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ policy: stored, effective: policyView(stored), changed });
}

function pick(p: { events: Record<string, unknown> }, ids: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of ids.slice(0, 100)) out[id] = p.events[id] ?? null;
  return out;
}

// POST   /api/helpdesk/push/subscriptions  turn push on for this browser
//        { subscription: PushSubscriptionJSON, label?, brave?, touch_mac? }
// DELETE /api/helpdesk/push/subscriptions  turn it off { endpoint }
// Agents only, licence-gated, same-origin (Helpdesk 1.19.0).

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { sessionSid } from "@/lib/db";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { pushRetryAfter, rememberPushOrigin, subscribePush, subscriptionProblem, unsubscribePush } from "@/lib/helpdesk/push";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const wait = pushRetryAfter(`sub:${gate.id}`, 30, 3_600_000);
  if (wait) {
    return NextResponse.json({ error: "Too many devices turned on in an hour. Try again later." }, { status: 429, headers: { "Retry-After": String(wait) } });
  }
  const body = await readJson<{ subscription?: unknown; label?: unknown; brave?: unknown; touch_mac?: unknown }>(req, 8 * 1024);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const problem = subscriptionProblem(body.subscription);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 60)) {
    return NextResponse.json({ error: "Name the device in 60 characters or fewer." }, { status: 400 });
  }
  rememberPushOrigin(req.headers.get("origin"));
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sid = token ? sessionSid(token) : null;
  const sub = body.subscription as { endpoint: string; keys: { p256dh: string; auth: string } };
  const device = await subscribePush(
    gate.id,
    { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    {
      userAgent: req.headers.get("user-agent") ?? "",
      label: typeof body.label === "string" ? body.label : "",
      brave: body.brave === true,
      touchMac: body.touch_mac === true,
      // Signing this session out turns the device off with it (lib/db forgetPushDevices).
      sessionSid: sid,
    }
  );
  return NextResponse.json({ device }, { status: 201 });
}

export async function DELETE(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson<{ endpoint?: unknown }>(req, 4 * 1024);
  if (!body || typeof body.endpoint !== "string" || !body.endpoint || body.endpoint.length > 1024) {
    return NextResponse.json({ error: "Send the subscription's endpoint." }, { status: 400 });
  }
  const removed = await unsubscribePush(gate.id, { endpoint: body.endpoint });
  return NextResponse.json({ ok: true, removed });
}

// POST /api/helpdesk/push/test { device_id? }: send a test notification to
// one of the agent's devices, or all of them. Rate-limited: 5 a minute and
// 30 an hour per agent (Helpdesk 1.19.0).

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { pushRetryAfter, sendTestPush } from "@/lib/helpdesk/push";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson<{ device_id?: unknown }>(req, 1024);
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const raw = body.device_id;
  if (raw !== undefined && raw !== null && !(Number.isInteger(raw) && (raw as number) > 0)) {
    return NextResponse.json({ error: "Device not found." }, { status: 404 });
  }
  const wait = Math.max(pushRetryAfter(`test-m:${gate.id}`, 5, 60_000), pushRetryAfter(`test-h:${gate.id}`, 30, 3_600_000));
  if (wait) {
    return NextResponse.json(
      { error: `Too many test notifications. Try again in ${wait} seconds.` },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }
  const result = await sendTestPush(gate.id, typeof raw === "number" ? raw : undefined);
  if (result.attempted === 0) {
    return NextResponse.json({ error: raw ? "Device not found." : "Turn on notifications on a device first." }, { status: 404 });
  }
  if (result.sent === 0) {
    const error =
      result.removed > 0
        ? "The browser no longer accepts notifications from the desk, so the device was removed. Turn notifications on again on it."
        : "The push service refused the test. The device shows the reason.";
    return NextResponse.json({ error, result }, { status: 502 });
  }
  return NextResponse.json({ ok: true, result });
}

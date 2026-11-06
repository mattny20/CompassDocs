// GET /api/helpdesk/push/vapid: the workspace's VAPID public key, which the
// desk's Notifications page subscribes the browser with (Helpdesk 1.19.0).
// The key pair is created on first use.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { vapidPublicKey } from "@/lib/helpdesk/push";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  try {
    return NextResponse.json({ public_key: await vapidPublicKey() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't prepare push keys." }, { status: 500 });
  }
}

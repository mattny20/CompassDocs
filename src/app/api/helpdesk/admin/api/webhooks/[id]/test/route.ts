// POST /api/helpdesk/admin/api/webhooks/[id]/test → { delivery }
// One signed "ping" to the endpoint now (waits for the answer, 10 seconds at most), logged
// as a test delivery, never retried, never counted against the hook.
// Desk settings → API and webhooks (1.19.4 C2). settings.manage. 10 a minute per person.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, tooMany } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { testWebhook, WebhookError } from "@/lib/helpdesk/webhooks";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (hdRateLimited(`hd-hook-test:${gate.id}`, 10, 60_000)) return tooMany();
  try {
    const actor = { ...actorFrom(gate), id: gate.id, name: gate.name || gate.username };
    return NextResponse.json({ delivery: await testWebhook(id, actor, ipFrom(req)) });
  } catch (e) {
    if (e instanceof WebhookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

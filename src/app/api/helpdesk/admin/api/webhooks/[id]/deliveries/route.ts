// GET /api/helpdesk/admin/api/webhooks/[id]/deliveries → { hook, deliveries }
// The delivery log: queued and retrying ones, then the newest 50 finished (status, response
// code, time, the first 2 KB of the answer). Never the payload or the secret.
// Desk settings → API and webhooks (1.19.4 C2). settings.manage.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { getWebhookView, listDeliveries } from "@/lib/helpdesk/webhooks";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  const hook = Number.isSafeInteger(id) && id > 0 ? await getWebhookView(id) : undefined;
  if (!hook) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ hook, deliveries: await listDeliveries(id) });
}

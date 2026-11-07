// POST /api/helpdesk/admin/api/webhooks/[id]/rotate → { hook, secret: "whsec_…" }
// A new signing secret, shown once; the old one stops signing at once.
// Desk settings → API and webhooks (1.19.4 C2). settings.manage. Audited (never the secret).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { rotateWebhookSecret, WebhookError } from "@/lib/helpdesk/webhooks";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  try {
    const actor = { ...actorFrom(gate), id: gate.id, name: gate.name || gate.username };
    const out = await rotateWebhookSecret(id, actor, ipFrom(req));
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof WebhookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

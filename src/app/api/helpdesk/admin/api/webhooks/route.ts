// POST /api/helpdesk/admin/api/webhooks  { name?, url, events, team_ids, include_notes }
//   → 201 { hook, secret: "whsec_…" }   The signing secret is in this answer only.
// Desk settings → API and webhooks (1.19.4 C2). settings.manage. https only; a private
// address only when the server sets COMPASSDOCS_FETCH_ALLOW_PRIVATE=1 (lib/safe-fetch).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { createWebhook, validateWebhookInput, WebhookError, type WebhookInput } from "@/lib/helpdesk/webhooks";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the webhook as JSON." }, { status: 400 });
  try {
    const input = (await validateWebhookInput(b)) as WebhookInput;
    const actor = { ...actorFrom(gate), id: gate.id, name: gate.name || gate.username };
    const { hook, secret } = await createWebhook(input, actor, ipFrom(req));
    return NextResponse.json({ hook, secret }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof WebhookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

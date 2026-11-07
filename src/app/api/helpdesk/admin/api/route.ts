// GET /api/helpdesk/admin/api → { tokens, webhooks, options }
// Desk settings → API and webhooks (1.19.4 C2). settings.manage. Never
// returns a token or a signing secret: only their last four characters.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { apiOptionsFor, listApiTokenViews } from "@/lib/helpdesk/api-tokens";
import { listWebhookViews } from "@/lib/helpdesk/webhooks";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const [tokens, webhooks, options] = await Promise.all([listApiTokenViews(), listWebhookViews(), apiOptionsFor({ ...gate, name: gate.name || gate.username })]);
  return NextResponse.json({ tokens, webhooks, options });
}

// POST /api/helpdesk/inbound/<secret>[?provider=generic|postmark|sendgrid|mailgun]
// Helpdesk 1.19.0: the inbound email webhook an email provider's inbound
// parse posts to. No session: the secret in the path (Desk → Settings →
// Email) is the credential, compared in constant time; a wrong one is a
// 404. Unlicensed: 402. A body over 40 MB is refused while it is read
// (413), chunked or not. Everything else (parsing, sender authentication,
// threading, outside senders, attachments, rate limits) is
// lib/helpdesk/inbound.

import { NextResponse } from "next/server";
import { handleInbound } from "@/lib/helpdesk/inbound";
import { ipFrom } from "@/lib/audit";
import { publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }) {
  const { secret } = await ctx.params;
  const url = new URL(req.url);
  const result = await handleInbound(req, secret, {
    providerHint: url.searchParams.get("provider") ?? "",
    origin: await publicOrigin(req),
    ip: ipFrom(req),
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

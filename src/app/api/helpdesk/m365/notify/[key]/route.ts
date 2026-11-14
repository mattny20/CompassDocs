// POST /api/helpdesk/m365/notify/<key>[?validationToken=…]
// Helpdesk 1.20.7: where Microsoft Graph posts change and lifecycle
// notifications for the connected help mailboxes. No session: the key in the
// path is part of the address each subscription was created with (a wrong
// one is a 404), and every notification must carry its subscription's
// clientState (compared in constant time), or nothing happens. Unlicensed:
// 402. The validation handshake is answered as plain text; notifications are
// answered 202 at once and worked after the response (next/server after()).
// Everything else is lib/helpdesk/m365/mail handleM365Notification.

import { after } from "next/server";
import { ipFrom } from "@/lib/audit";
import { handleM365Notification } from "@/lib/helpdesk/m365/mail";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const r = await handleM365Notification(req, key, { ip: ipFrom(req) });
  if (r.work) after(r.work);
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (r.text !== undefined) return new Response(r.text, { status: r.status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(null, { status: r.status, headers });
}

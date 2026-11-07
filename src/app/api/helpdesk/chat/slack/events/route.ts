// POST /api/helpdesk/chat/slack/events
// Helpdesk 1.19.4: the Request URL of the admin's Slack app, for both Event
// Subscriptions (JSON) and Interactivity (form-encoded `payload`). The
// signature (X-Slack-Signature over v0:timestamp:body with the signing
// secret, within five minutes) is checked before anything is read; an
// unsigned or stale request is 401 and never processed. A signed one is
// answered at once (Slack wants it within three seconds) and handled after
// the response (next/server after()). All of it is lib/helpdesk/chat/inbound.

import { after, NextResponse } from "next/server";
import { handleSlackRequest } from "@/lib/helpdesk/chat/inbound";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const r = await handleSlackRequest(req);
  if (r.work) after(r.work);
  const headers = { "Cache-Control": "no-store" };
  return r.body === undefined ? new Response(null, { status: r.status, headers }) : NextResponse.json(r.body, { status: r.status, headers });
}

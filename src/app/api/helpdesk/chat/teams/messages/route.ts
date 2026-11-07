// POST /api/helpdesk/chat/teams/messages
// Helpdesk 1.19.4: the messaging endpoint of the admin's Azure Bot (Microsoft
// Teams). Every activity carries the Bot Framework's JWT; it is verified
// (lib/helpdesk/chat/teams verifyBotToken) before anything is read, and an
// unverified one is 401 and never processed. A verified activity is answered
// at once and handled after the response (next/server after()).
// All of it is lib/helpdesk/chat/inbound.

import { after, NextResponse } from "next/server";
import { handleTeamsRequest } from "@/lib/helpdesk/chat/inbound";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const r = await handleTeamsRequest(req);
  if (r.work) after(r.work);
  const headers = { "Cache-Control": "no-store" };
  return r.body === undefined ? new Response(null, { status: r.status, headers }) : NextResponse.json(r.body, { status: r.status, headers });
}

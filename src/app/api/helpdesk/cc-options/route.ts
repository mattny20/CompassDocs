// GET /api/helpdesk/cc-options   what the "Add people" pickers may offer:
//   { outside_allowed } (outside addresses may be copied while Desk ->
//   Settings -> Email allows outside senders). 1.19.1 (agent V3).
// Helpdesk (helpdesk.request).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { getHelpdeskSettings } from "@/lib/helpdesk/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ outside_allowed: (await getHelpdeskSettings()).outside_senders === true });
}

// GET /api/helpdesk/mailboxes   → { mailboxes: [{ id, address, name, is_default, send_from, send_address }] }
//        (1.20.5: `send_address` is the address replies go out From, null = the workspace address;
//        `send_from` stays, true when that is the address itself)
// Helpdesk 1.20.2 (lib/helpdesk/mailboxes): the help addresses as an agent reads them (the
// queue's Address filter and the address beside a ticket's channel, shown while more than one
// is listed). Agents only, and each agent their own: the default, addresses with no team and
// their teams' addresses (every address with tickets.view_all or settings.manage), the same
// list a ticket's "Answer from" offers them.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { mailboxOptions } from "@/lib/helpdesk/mailboxes";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ mailboxes: await mailboxOptions(gate) });
}

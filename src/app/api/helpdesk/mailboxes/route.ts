// GET /api/helpdesk/mailboxes   → { mailboxes: [{ id, address, name, is_default, send_from }] }
// Helpdesk 1.20.2 (lib/helpdesk/mailboxes): the help addresses as an agent reads them (the
// queue's Address filter and the address beside a ticket's channel, shown while more than one
// is listed). Agents only; addresses are the workspace's own, nothing personal.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { mailboxOptions } from "@/lib/helpdesk/mailboxes";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ mailboxes: await mailboxOptions() });
}

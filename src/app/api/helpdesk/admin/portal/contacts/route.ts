// GET /api/helpdesk/admin/portal/contacts?q=   → { contacts }
//   The customer portal's contacts who signed in, raised something or are
//   blocked (an address that only asked for a link is not listed), blocked
//   first, with their request and live-session counts.
// Helpdesk 1.19.1 (agent V6). Desk capability settings.manage.

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { listPortalContacts } from "@/lib/helpdesk/portal";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return NextResponse.json({ contacts: await listPortalContacts(q, 50) });
}

// GET /api/helpdesk/counts   the desk rail's view and team counts and the
//   headline tiles (open, overdue, first-reply median, satisfaction) in the
//   caller's scope → HdCounts
// Helpdesk 1.19.0 (helpdesk.agent).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { countViews } from "@/lib/helpdesk/tickets";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await countViews(gate));
}

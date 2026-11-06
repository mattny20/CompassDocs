// GET /api/helpdesk/checklists → { templates: [{ id, name, items, required }] }
// Helpdesk 1.19.2 (agent W3): the checklist library in short, for agents (the
// workflow builder's task step "Add checklist"). Names only: items are read on a ticket.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { templateOptions } from "@/lib/helpdesk/checklists";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ templates: await templateOptions() });
}

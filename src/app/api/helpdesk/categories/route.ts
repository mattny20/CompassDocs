// GET /api/helpdesk/categories → { categories: [{ id, name, archived, subcategories: [{ id, name, archived }] }], can_manage }
// Helpdesk 1.20.6 (lib/helpdesk/categories): the desk admin's list of categories and sub-categories, as
// the desk's pickers read it (the ticket side panel, the Filter dialog, the request type and automation
// editors, Before you solve). Archived entries are included and marked, so a ticket that still has one
// can show it; pickers leave them out. `can_manage`: the caller may open Desk settings → Categories.
// Anyone on the desk side: an agent, a helpdesk admin or a reports reader.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { hdCan } from "@/lib/helpdesk/roles";
import { categoryTree } from "@/lib/helpdesk/categories";

export const dynamic = "force-dynamic";

export async function GET() {
  let gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse && gate.status === 403) gate = await helpdeskGate("admin");
  if (gate instanceof NextResponse && gate.status === 403) gate = await helpdeskGate("reports");
  if (gate instanceof NextResponse) return gate;
  const [categories, canManage] = await Promise.all([categoryTree(), hdCan(gate, "settings.manage").catch(() => false)]);
  return NextResponse.json({ categories, can_manage: canManage });
}

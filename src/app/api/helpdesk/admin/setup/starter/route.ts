// POST /api/helpdesk/admin/setup/starter   write the starter set (what is
//   missing of it): teams IT/HR/Facilities, the starter reply targets, six
//   request types with their workflows, three macros, the "VPN and network"
//   rule. Idempotent. → { added: StarterResult, checklist }
//   Audited (helpdesk.setup.starter).
// Helpdesk 1.19.0 (desk capability settings.manage).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { seedStarterSet, setupChecklist } from "@/lib/helpdesk/seed";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const added = await seedStarterSet(gate.id);
  (await import("@/lib/helpdesk/calendars")).invalidateCalendarCache();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.setup.starter",
    targetType: "helpdesk_settings",
    targetLabel: "Helpdesk starter set",
    details: { ...added },
    ip: ipFrom(req),
  });
  return NextResponse.json({ added, checklist: await setupChecklist() });
}

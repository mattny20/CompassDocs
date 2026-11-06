// GET /api/helpdesk/admin/sla   → { policies, hours } (the targets and the business hours they count)
// PUT /api/helpdesk/admin/sla   { policies: [{ priority, name?, first_reply_minutes, resolve_minutes, business_hours? }] }
//       replaces the targets (priorities left out lose theirs); existing
//       tickets keep their dues. Audited (helpdesk.sla.updated).
// Helpdesk 1.19.0 (desk capability sla.manage). Business hours are settings
// (PATCH /api/helpdesk/admin/settings).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { listSlaPolicies, saveSlaPolicies, validateSlaPolicies } from "@/lib/helpdesk/db-sla";
import { getBusinessHours, markSetupSteps } from "@/lib/helpdesk/settings";
import { starterPolicies } from "@/lib/helpdesk/sla";
import { badRequest } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("sla.manage");
  if (gate instanceof NextResponse) return gate;
  const hours = await getBusinessHours();
  return NextResponse.json({ policies: await listSlaPolicies(), hours, starter: starterPolicies(hours) });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("sla.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the targets as JSON.");
  const v = validateSlaPolicies(b.policies);
  if (!v.ok) return badRequest(v.error);
  const before = await listSlaPolicies();
  const policies = await saveSlaPolicies(v.value);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.sla.updated",
    targetType: "helpdesk_sla",
    targetLabel: "Reply targets",
    details: {
      before: before.map(({ id: _i, ...p }) => p),
      after: policies.map(({ id: _i, ...p }) => p),
    },
    ip: ipFrom(req),
  });
  await markSetupSteps(["hours"]);
  return NextResponse.json({ policies });
}

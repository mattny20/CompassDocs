// POST /api/helpdesk/admin/automations/reorder   { ids: number[] }  the run order, first to last
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Every automation must be named once.
// Audited as helpdesk.automation.reordered.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { withTx } from "@/lib/helpdesk/db-core";
import { listAutomations } from "@/lib/helpdesk/automations";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson<{ ids?: unknown }>(req, 16 * 1024);
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : null;
  const current = await listAutomations();
  if (!ids || ids.length !== current.length || new Set(ids).size !== ids.length || !current.every((a) => ids.includes(a.id))) {
    return NextResponse.json({ error: "Send every automation's id once, in the new order." }, { status: 400 });
  }
  await withTx(async (client) => {
    for (const [i, id] of ids.entries()) await client.query("UPDATE hd_automations SET position = $2, updated_at = now() WHERE id = $1", [id, i]);
  });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.automation.reordered",
    targetType: "helpdesk_automation",
    details: { ids },
    ip: ipFrom(req),
  });
  return NextResponse.json({ automations: await listAutomations() });
}

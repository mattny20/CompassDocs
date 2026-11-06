// GET  /api/helpdesk/tickets/[number]/assets/solve → { offer: HdSolveOffer | null }: what the
//      desk's solve flow (Solve, `e`, Send and set Solved) offers to log in Snipe-IT. Null when the
//      setting is off, nothing is linked or the source takes no maintenance.
// POST /api/helpdesk/tickets/[number]/assets/solve  { asset_ids, type, supplier_id, note }
//      → MaintenanceOutcome. Sent by the desk AFTER the solve committed: 409 unless the ticket is
//      solved. Each failure leaves an internal note and the ticket stays solved. Audited
//      (helpdesk.asset.maintenance_logged / helpdesk.asset.maintenance_failed).
// Helpdesk 1.19.3 (lib/helpdesk/assets; mock-up i4). Agents who work the ticket and may change
// its status (tickets.change_status), as solving needs.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { loadTicketFor } from "@/lib/helpdesk/routes";
import { AssetError, checkMaintenanceRequest, logMaintenance, solveOffer } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ offer: await solveOffer(found.ticket) });
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  if (!(await hdCan(gate, "tickets.change_status", { teamId: t.team_id }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const checked = checkMaintenanceRequest(await readJson(req, 8 * 1024));
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    const out = await logMaintenance(t, checked.value, { id: gate.id, name: gate.name || gate.username });
    const base = { actor: actorFrom(gate), targetType: "helpdesk_ticket", targetId: t.id, targetLabel: `#${t.number} ${t.subject}`.slice(0, 200), ip: ipFrom(req) };
    for (const l of out.logged) {
      await audit({ ...base, action: "helpdesk.asset.maintenance_logged", details: { number: t.number, asset_id: l.asset_id, tag: l.tag, type: checked.value.type, supplier_id: checked.value.supplier_id, record_id: l.record_id } });
    }
    for (const f of out.failed) {
      await audit({ ...base, action: "helpdesk.asset.maintenance_failed", details: { number: t.number, asset_id: f.asset_id, tag: f.tag, type: checked.value.type, error: f.error } });
    }
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof AssetError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

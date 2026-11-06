// GET /api/helpdesk/admin/calendars/teams/[teamId]/sla   → HdTeamSlaView { team, targets, workspace }
// PUT /api/helpdesk/admin/calendars/teams/[teamId]/sla   { targets: [{ priority, first_reply_minutes, resolve_minutes, business_hours? }] | null }
//       the team's own reply targets (priorities left out use the workspace's;
//       null or [] = back to the workspace targets). Re-times the team's open,
//       running clocks: time already used stays used. → { view, retimed }
// Helpdesk 1.19.0, agent L (sla.manage). Audited (helpdesk.team.sla_updated / helpdesk.team.sla_reset).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { getTeamSlaView, saveTeamSlaTargets } from "@/lib/helpdesk/calendars";
import { validateSlaPolicies } from "@/lib/helpdesk/db-sla";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { auditCalendar, calendarGate, idOf } from "../../../helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ teamId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).teamId);
  const view = id ? await getTeamSlaView(id) : undefined;
  if (!view) return notFound();
  return NextResponse.json(view);
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await calendarGate();
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).teamId);
  if (!id) return notFound();
  const b = await readJson(req, 16 * 1024);
  if (!b || !("targets" in b)) return badRequest("Send { targets: [...] } or { targets: null }.");
  let targets: { priority: import("@/lib/helpdesk/types").HdPriority; first_reply_minutes: number; resolve_minutes: number; business_hours: number }[] | null = null;
  if (b.targets !== null) {
    const v = validateSlaPolicies(b.targets);
    if (!v.ok) return badRequest(v.error);
    targets = v.value.map(({ priority, first_reply_minutes, resolve_minutes, business_hours }) => ({ priority, first_reply_minutes, resolve_minutes, business_hours }));
    if (!targets.length) targets = null;
  }
  const r = await saveTeamSlaTargets(id, targets, gate.id);
  if (!r) return notFound();
  const reset = targets === null;
  if (!(reset && r.before.length === 0) && JSON.stringify(r.before) !== JSON.stringify(r.view.targets)) {
    await auditCalendar(req, gate, reset ? "helpdesk.team.sla_reset" : "helpdesk.team.sla_updated", { type: "helpdesk_team", id, label: r.view.team.name }, {
      before: r.before,
      after: r.view.targets,
      retimed: r.retimed,
    });
  }
  return NextResponse.json({ view: r.view, retimed: r.retimed });
}

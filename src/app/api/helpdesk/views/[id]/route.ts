// PATCH  /api/helpdesk/views/[id]   { name?, filters? } → { view }   audited helpdesk.view.updated
// DELETE /api/helpdesk/views/[id]   → { ok }                          audited helpdesk.view.deleted
// Helpdesk 1.19.1 saved views (agent V4, lib/helpdesk/saved-views). A view
// the caller does not see is 404; one they see but may not change (a team
// view for a member who is not a lead there) is 403.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { cleanViewFilters, cleanViewName, deleteView, getVisibleView, SavedViewError, updateView } from "@/lib/helpdesk/saved-views";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(params: Ctx["params"]) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const view = await getVisibleView(gate, Number((await params).id));
  if (!view) return NextResponse.json({ error: "That view doesn't exist." }, { status: 404 });
  if (!view.can_edit) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  return { gate, view };
}

export async function PATCH(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  const { gate, view } = ctx;
  if (hdRateLimited(`hd-views:${gate.id}`, 30, 60_000)) return tooMany();
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  try {
    const patch: { name?: string; filters?: Record<string, string> } = {};
    if (b.name !== undefined) patch.name = cleanViewName(b.name);
    if (b.filters !== undefined) patch.filters = await cleanViewFilters(b.filters);
    if (!Object.keys(patch).length) return NextResponse.json({ view });
    const next = await updateView(gate, view.id, patch);
    if (!next) return NextResponse.json({ error: "That view doesn't exist." }, { status: 404 });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.view.updated",
      targetType: "helpdesk_view",
      targetId: view.id,
      targetLabel: next.name,
      details: {
        scope: view.team_id ? "team" : "personal",
        team_id: view.team_id,
        ...(patch.name !== undefined && patch.name !== view.name ? { renamed_from: view.name } : {}),
        ...(patch.filters ? { filters: patch.filters } : {}),
      },
      ip: ipFrom(req),
    });
    return NextResponse.json({ view: next });
  } catch (e) {
    if (e instanceof SavedViewError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  const { gate, view } = ctx;
  await deleteView(view.id);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.view.deleted",
    targetType: "helpdesk_view",
    targetId: view.id,
    targetLabel: view.name,
    details: { scope: view.team_id ? "team" : "personal", team_id: view.team_id, filters: view.filters },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

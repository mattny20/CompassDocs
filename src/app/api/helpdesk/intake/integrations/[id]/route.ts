// GET    /api/helpdesk/intake/integrations/<id> → { integration }
// PATCH  /api/helpdesk/intake/integrations/<id> any of { name, default_team_id, default_priority,
//          severity_map, dedup_window_minutes, auto_resolve, reopen_on_repeat,
//          rate_limit_per_minute, enabled, sender_addresses, subject_dedup_pattern,
//          allow_unverified_mail (email) } → { integration }
// DELETE /api/helpdesk/intake/integrations/<id> → { ok } (its tickets stay, unlinked)
// Helpdesk 1.19.0 (agent P). Desk capability channels.manage (or
// settings.manage). Audited: helpdesk.integration.updated (changed fields),
// helpdesk.integration.deleted.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { intakeAdminGate } from "@/lib/helpdesk/intake/details";
import {
  deleteIntegration,
  getIntegrationView,
  IntegrationInputError,
  updateIntegration,
  validateIntegrationInput,
} from "@/lib/helpdesk/intake/integrations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => {
  const { id } = await ctx.params;
  return /^\d{1,10}$/.test(id) ? Number(id) : 0;
};

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const integration = await getIntegrationView(await idOf(ctx));
  if (!integration) return notFound();
  return NextResponse.json({ integration }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  const body = await readJson(req, 32 * 1024);
  if (!body) return badRequest("Send a JSON object.");
  try {
    const input = validateIntegrationInput(body, { create: false });
    const r = await updateIntegration(id, input);
    if (!r) return notFound();
    if (r.changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.integration.updated",
        targetType: "helpdesk_integration",
        targetId: id,
        targetLabel: r.integration.name,
        details: { changed: r.changed, ...(r.changed.includes("enabled") ? { enabled: r.integration.enabled } : {}) },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ integration: r.integration });
  } catch (e) {
    if (e instanceof IntegrationInputError) return badRequest(e.message);
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await intakeAdminGate();
  if (gate instanceof NextResponse) return gate;
  const row = await deleteIntegration(await idOf(ctx));
  if (!row) return notFound();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.integration.deleted",
    targetType: "helpdesk_integration",
    targetId: row.id,
    targetLabel: row.name,
    details: { kind: row.kind },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

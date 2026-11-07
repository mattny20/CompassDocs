// PATCH  /api/helpdesk/admin/api/webhooks/[id]  { name?, url?, events?, team_ids?, include_notes?, enabled? } → { hook }
//          Turning it off fails its queued deliveries; turning it on clears its failing state.
// DELETE /api/helpdesk/admin/api/webhooks/[id]  → { ok }  (its delivery log goes with it)
// Desk settings → API and webhooks (1.19.4 C2). settings.manage. Audited.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { deleteWebhook, updateWebhook, validateWebhookInput, WebhookError } from "@/lib/helpdesk/webhooks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function hookId(params: Ctx["params"]): Promise<number | null> {
  const id = Number((await params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await hookId(params);
  if (!id) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const b = await readJson(req, 16 * 1024);
  if (!b) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return NextResponse.json({ error: "enabled is true or false." }, { status: 400 });
  try {
    const patch = await validateWebhookInput(b, true);
    const actor = { ...actorFrom(gate), id: gate.id, name: gate.name || gate.username };
    const hook = await updateWebhook(id, { ...patch, ...(b.enabled !== undefined ? { enabled: b.enabled as boolean } : {}) }, actor, ipFrom(req));
    return NextResponse.json({ hook });
  } catch (e) {
    if (e instanceof WebhookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await hookId(params);
  if (!id) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const actor = { ...actorFrom(gate), id: gate.id, name: gate.name || gate.username };
  if (!(await deleteWebhook(id, actor, ipFrom(req)))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}

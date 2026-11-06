import { NextResponse } from "next/server";
import { emailTemplatesGate, canComposeEvent, canSeeEvent, readJsonBody, BAD_JSON, FORBIDDEN } from "@/lib/email-parts-access";
import { deleteComposition, getComposition, isScope, putComposition, SCOPE_ALL } from "@/lib/email-parts";
import type { EmailComposition } from "@/lib/email-parts";
import { templateDef } from "@/lib/email-templates";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// One event's composition. GET ?scope=; PUT {scope?, header_id?, body_id?,
// signature_id?, footer_id?} (a slot left out keeps its value, null
// inherits); DELETE ?scope=hd_team:<id> removes a team's variant.
// Template managers: every event. helpdesk.admin: hd_* events.

type Ctx = { params: Promise<{ event: string }> };

const UNKNOWN = () => NextResponse.json({ error: "Unknown email event." }, { status: 404 });
const BAD_SCOPE = () => NextResponse.json({ error: "Unknown scope: use 'all' or 'hd_team:<id>'." }, { status: 400 });

const slotIds = (c: EmailComposition) => ({
  header_id: c.header.id,
  body_id: c.body.id,
  signature_id: c.signature.id,
  footer_id: c.footer.id,
});

export async function GET(req: Request, { params }: Ctx) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const event = decodeURIComponent((await params).event);
  if (!templateDef(event)) return UNKNOWN();
  if (!canSeeEvent(gate, event)) return FORBIDDEN();
  const scope = new URL(req.url).searchParams.get("scope") || SCOPE_ALL;
  if (!isScope(scope)) return BAD_SCOPE();
  return NextResponse.json({ composition: await getComposition(event, scope), can_manage: canComposeEvent(gate, event) });
}

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const event = decodeURIComponent((await params).event);
  const def = templateDef(event);
  if (!def) return UNKNOWN();
  if (!canComposeEvent(gate, event)) return FORBIDDEN();
  const body = await readJsonBody(req);
  if (!body) return BAD_JSON();
  const scope = body.scope === undefined || body.scope === null || body.scope === "" ? SCOPE_ALL : body.scope;
  if (!isScope(scope)) return BAD_SCOPE();
  const out = await putComposition(
    event,
    scope,
    { header_id: body.header_id, body_id: body.body_id, signature_id: body.signature_id, footer_id: body.footer_id },
    gate.user.id
  );
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  const before = slotIds(out.before);
  const after = slotIds(out.after);
  if (!out.before.stored || JSON.stringify(before) !== JSON.stringify(after)) {
    await audit({
      actor: actorFrom(gate.user),
      action: "email_template.composition_updated",
      targetType: "email_template",
      targetId: scope === SCOPE_ALL ? event : `${event}@${scope}`,
      targetLabel: def.label,
      details: { event_key: event, scope, before, after },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ composition: out.after });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await emailTemplatesGate();
  if (gate instanceof NextResponse) return gate;
  const event = decodeURIComponent((await params).event);
  const def = templateDef(event);
  if (!def) return UNKNOWN();
  if (!canComposeEvent(gate, event)) return FORBIDDEN();
  const scope = new URL(req.url).searchParams.get("scope") ?? "";
  const out = await deleteComposition(event, scope);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
  if (out.ok) {
    await audit({
      actor: actorFrom(gate.user),
      action: "email_template.composition_removed",
      targetType: "email_template",
      targetId: `${event}@${scope}`,
      targetLabel: def.label,
      details: { event_key: event, scope },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ok: out.ok, composition: await getComposition(event, scope) });
}

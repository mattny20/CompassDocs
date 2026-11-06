// GET    /api/helpdesk/admin/request-types/[id]   the type (with open_requests for the delete dialog)
// PATCH  /api/helpdesk/admin/request-types/[id]   any of the POST fields; left out = unchanged
// DELETE /api/helpdesk/admin/request-types/[id]   its requests keep their answers (request_type_id SET NULL)
// Helpdesk 1.19.0 (desk capability request_types.manage).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import {
  deleteRequestType,
  getRequestType,
  openRequestCount,
  updateRequestType,
  validateRequestTypeInput,
} from "@/lib/helpdesk/request-types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await hdCapGate("request_types.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const rt = id === null ? undefined : await getRequestType(id);
  if (!rt) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ request_type: rt, open_requests: await openRequestCount(rt.id) });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("request_types.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const existing = id === null ? undefined : await getRequestType(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJson(req, 128 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const input = await validateRequestTypeInput(body, existing);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  let rt;
  try {
    rt = await updateRequestType(existing.id, input.value);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "Another request type already uses that address name." }, { status: 409 });
    }
    throw e;
  }
  if (!rt) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.request_type.updated",
    targetType: "helpdesk_request_type",
    targetId: rt.id,
    targetLabel: rt.title,
    details: { fields: Object.keys(body).slice(0, 20), workflow_id: rt.workflow_id, active: rt.active },
    ip: ipFrom(req),
  });
  return NextResponse.json({ request_type: rt });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("request_types.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const removed = id === null ? undefined : await deleteRequestType(id);
  if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.request_type.deleted",
    targetType: "helpdesk_request_type",
    targetId: removed.id,
    targetLabel: removed.title,
    details: { slug: removed.slug },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

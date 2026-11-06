// GET  /api/helpdesk/admin/request-types   every request type (switched-off ones too)
// POST /api/helpdesk/admin/request-types   { title, slug?, description?, icon?, team_id?, category?,
//        form?, workflow_id?, sla_priority?, visibility?, group_ids?, active?, position?, eta_label? }
// Helpdesk 1.19.0 (desk capability request_types.manage). The form is checked field by field
// (lib/helpdesk/request-types validateFormFields).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { createRequestType, listRequestTypes, validateRequestTypeInput } from "@/lib/helpdesk/request-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("request_types.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ request_types: await listRequestTypes() });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("request_types.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 128 * 1024);
  if (!body) return NextResponse.json({ error: "Send the request type as JSON." }, { status: 400 });
  const input = await validateRequestTypeInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  let rt;
  try {
    rt = await createRequestType(input.value);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "Another request type already uses that address name." }, { status: 409 });
    }
    throw e;
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.request_type.created",
    targetType: "helpdesk_request_type",
    targetId: rt.id,
    targetLabel: rt.title,
    details: { slug: rt.slug, team_id: rt.team_id, workflow_id: rt.workflow_id, fields: rt.form.length, visibility: rt.visibility },
    ip: ipFrom(req),
  });
  return NextResponse.json({ request_type: rt }, { status: 201 });
}

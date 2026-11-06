// GET /api/helpdesk/request-types/[slug]   one request type's form, prefilled
//   answers from the requester's directory entry (fields with default_from
//   "directory:<field>") and "What happens next" from its published workflow.
// Helpdesk 1.19.0 (helpdesk.request). 404 for a type the caller may not use.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { getRequestTypeBySlug, mayUseRequestType } from "@/lib/helpdesk/request-types";
import { directoryDefaults, nextStepsFor } from "@/lib/helpdesk/detail";
import type { HdRequestTypeForm } from "@/lib/helpdesk/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const { slug } = await params;
  const rt = await getRequestTypeBySlug(String(slug).slice(0, 80));
  if (!rt || !(await mayUseRequestType(gate, rt.id))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { group_ids: _g, ...request_type } = rt;
  const body: HdRequestTypeForm = {
    request_type,
    next_steps: await nextStepsFor(rt),
    defaults: await directoryDefaults(gate.id, rt.form),
  };
  return NextResponse.json(body);
}

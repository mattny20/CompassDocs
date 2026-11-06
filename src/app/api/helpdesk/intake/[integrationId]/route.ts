// POST /api/helpdesk/intake/<integration id>
// Helpdesk 1.19.0 (agent P): where monitoring tools, bots and scripts send
// alerts. `Authorization: Bearer <key>`; the integration's kind decides how
// the JSON is read (generic, Alertmanager, Grafana, Datadog, Azure Monitor,
// PagerDuty-style). All of it is lib/helpdesk/intake/http.

import { NextResponse } from "next/server";
import { handleIntakeRequest } from "@/lib/helpdesk/intake/http";
import { ipFrom } from "@/lib/audit";
import { publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await ctx.params;
  const r = await handleIntakeRequest(req, integrationId, { origin: await publicOrigin(req), ip: ipFrom(req) });
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

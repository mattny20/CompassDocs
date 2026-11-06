// GET /api/helpdesk/approvals                approvals waiting for my decision (oldest first)
// GET /api/helpdesk/approvals?state=decided  the ones I decided (last 90 days)
// GET /api/helpdesk/approvals?state=desk     agents: pending approvals on requests in my queues
// Helpdesk 1.19.0. Approvers read the request's answers and opening
// message, never its internal notes (lib/helpdesk/approvals).

import { NextResponse } from "next/server";
import { agentTeamIds, helpdeskGate, isAgent } from "@/lib/helpdesk/access";
import { countMyPendingApprovals, listDeskApprovals, listMyApprovals } from "@/lib/helpdesk/approvals";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const state = new URL(req.url).searchParams.get("state") ?? "pending";
  if (state === "desk") {
    if (!(await isAgent(gate))) return NextResponse.json({ error: "You don't have permission for that." }, { status: 403 });
    return NextResponse.json({ approvals: await listDeskApprovals(gate, await agentTeamIds(gate)) });
  }
  if (state !== "pending" && state !== "decided") return NextResponse.json({ error: "Unknown list." }, { status: 400 });
  const [approvals, waiting] = await Promise.all([listMyApprovals(gate, state), countMyPendingApprovals(gate)]);
  return NextResponse.json({ approvals, waiting });
}

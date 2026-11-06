// GET  /api/helpdesk/approvals/[id]   one approval I am asked by (404 otherwise)
// POST /api/helpdesk/approvals/[id]   { decision: 'approved' | 'declined', note }
//                                      (a note is required to decline; the requester reads it)
// Helpdesk 1.19.0. The decision is recorded and the workflow moves on in
// one transaction under the run's lock (lib/helpdesk/engine decide), so a
// second click, or a second approver, answers 409.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { approvalRateLimited, decideApproval, getApprovalForUser } from "@/lib/helpdesk/approvals";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  const approval = id === null ? undefined : await getApprovalForUser(gate, id);
  if (!approval) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ approval });
}

export async function POST(req: Request, ctx: Ctx) {
  const gate = await helpdeskGate("request");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  if (id === null) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (approvalRateLimited("decide", gate.id)) {
    return NextResponse.json({ error: "Too many decisions at once. Try again in a few minutes." }, { status: 429 });
  }
  const body = await readJson<{ decision?: unknown; note?: unknown }>(req, 16 * 1024);
  if (!body) return NextResponse.json({ error: "Send the decision as JSON." }, { status: 400 });
  const result = await decideApproval(gate, id, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ approval: result.approval, run_state: result.run_state });
}

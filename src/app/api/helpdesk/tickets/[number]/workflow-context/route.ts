// GET /api/helpdesk/tickets/[number]/workflow-context
// The request behind a workflow task, read-only, for anyone who may work
// the request or any task of its run: requester, answers, the public
// conversation, every step's progress, hand-offs and sibling tasks
// (lib/helpdesk/task-context); from a task ticket, that task's pinned step
// (`task`: hand-off fields, on_cant_do, coordinating team) and `viewer`
// (their teams with a task on it, may they work the request). 404
// otherwise. Helpdesk 1.19.0.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { getWorkflowContext } from "@/lib/helpdesk/task-context";
import { parseTicketNumber } from "@/lib/helpdesk/tickets";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const number = parseTicketNumber((await params).number);
  const context = number === null ? null : await getWorkflowContext(gate, number);
  if (!context) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ context });
}

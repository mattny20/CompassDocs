// POST /api/helpdesk/runs/[id]/retry-step  { step_key? }
// The coordinating team tries a task that couldn't be done again: a new
// task ticket for the same team, and the workflow carries on. Only for a
// run on hold, by someone who may work its request. Helpdesk 1.19.0.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { retryStep } from "@/lib/helpdesk/engine";
import { runForCoordinator } from "@/lib/helpdesk/task-context";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const run = await runForCoordinator(gate, (await params).id);
  if (!run) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = (await readJson<{ step_key?: unknown }>(req, 8 * 1024)) ?? {};
  const stepKey = typeof body.step_key === "string" ? body.step_key.slice(0, 40) : undefined;
  const result = await retryStep(gate, run.id, stepKey);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow_run.step_retried",
    targetType: "helpdesk_ticket",
    targetId: run.ticket_number,
    targetLabel: `#${run.ticket_number}`,
    details: { run_id: run.id, step_key: stepKey ?? null },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, run_state: result.run_state });
}

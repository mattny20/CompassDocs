// POST /api/helpdesk/runs/[id]/cancel  { note? }
// Stop a request's workflow (running, waiting or on hold). Task tickets
// already created stay with their teams. By someone who may work the
// request. Helpdesk 1.19.0.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { cancelRun, TASK_NOTE_MAX } from "@/lib/helpdesk/engine";
import { runForCoordinator } from "@/lib/helpdesk/task-context";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const run = await runForCoordinator(gate, (await params).id);
  if (!run) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = (await readJson<{ note?: unknown }>(req, 16 * 1024)) ?? {};
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > TASK_NOTE_MAX) return NextResponse.json({ error: `The note is longer than ${TASK_NOTE_MAX} characters.` }, { status: 400 });
  const stopped = await cancelRun(run.id, { reason: "cancelled", actorName: gate.name || gate.username, note });
  if (!stopped) return NextResponse.json({ error: "This workflow has already ended." }, { status: 409 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow_run.cancelled",
    targetType: "helpdesk_ticket",
    targetId: run.ticket_number,
    targetLabel: `#${run.ticket_number}`,
    details: { run_id: run.id, was: run.state, note: note.slice(0, 500) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, run_state: "cancelled" });
}

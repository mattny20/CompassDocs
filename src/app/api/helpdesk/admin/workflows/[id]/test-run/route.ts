// POST /api/helpdesk/admin/workflows/[id]/test-run
//   { definition?, answers?, requester_id?, request_type_id?, decline_at? }
// A dry run: what each step would do with these answers (who approves,
// when tasks are due, when waits end). The definition defaults to the
// builder's working copy (draft, else published). Reads only: nothing is
// created, sent or audited. Helpdesk 1.19.0 (desk capability workflows.manage).

import { NextResponse } from "next/server";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { getWorkflow, simulateWorkflow, workingDefinition } from "@/lib/helpdesk/workflows";
import type { HdFormAnswers } from "@/lib/helpdesk/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const optId = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

export async function POST(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("workflows.manage");
  if (gate instanceof NextResponse) return gate;
  const raw = (await ctx.params).id;
  const workflow = /^\d{1,9}$/.test(raw) ? await getWorkflow(Number(raw)) : undefined;
  if (!workflow) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJson(req, 256 * 1024);
  if (!body) return NextResponse.json({ error: "Send the test as JSON." }, { status: 400 });
  const answers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? (body.answers as HdFormAnswers) : {};
  if (JSON.stringify(answers).length > 64 * 1024) return NextResponse.json({ error: "The sample answers are too long." }, { status: 400 });
  const linked = workflow.request_types[0]?.id ?? null;
  const result = await simulateWorkflow(
    body.definition ?? workingDefinition(workflow),
    {
      answers,
      requester_id: optId(body.requester_id),
      request_type_id: optId(body.request_type_id) ?? linked,
      decline_at: typeof body.decline_at === "string" ? body.decline_at.slice(0, 40) : undefined,
    },
    gate
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ test: result.value });
}

import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import { parseAssignmentRequest } from "@/lib/ack-assignments";
import { runAssignmentAction } from "@/lib/ack-assignment-actions";

export const dynamic = "force-dynamic";

// POST { action, assignment_ids, days?, reason?, until? } (D2 / D4, 1.13.0):
// the portal's per-person levers on policy_assignments rows of any policy.
//
//   exempt       { reason (required, ≤ 300), until? (YYYY-MM-DD, after today) }
//   unexempt     back to pending with a fresh deadline from the cascade
//   extend       { days (1..365, default 7), reason? }: due_at pushed out,
//                escalation and snooze cleared, the move kept in due_history
//   undo_extend  the inverse of the last extend on each row
//   snooze       { days (1..30, default 7) }: reminders paused, nothing
//                else changes (the invariant in lib/ack-assignments)
//   unsnooze     reminders resume
//   reask        { reason (10+) }: those people's cycle restarts (D4)
//
// assignment_ids: 1 to 200 ids. Answers { ok, action, changed, skipped }
// (snooze adds `until`); 400 with the first problem named, 400 "Ask another
// compliance manager to record your exemption." when the ids include the
// caller's own row (nothing is written then). Gated like every other
// portal write: the Compliance section and compliance.program_manage
// (complianceGuard), then the licence. The space-scoped twin for a steward
// without the section is POST /api/documents/[id]/acknowledgements/actions.
export async function POST(req: Request) {
  const gate = await complianceGuard("compliance.program_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate;
  if (!(await featureEnabled("policy_ack"))) {
    return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = parseAssignmentRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const outcome = await runAssignmentAction(parsed.req, {
    doc: null,
    actor: { id: user.id, name: user.name || user.username },
    audit: { actor: actorFrom(user), ip: ipFrom(req) },
    origin: requestOrigin(req),
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}

// GET   /api/helpdesk/me/auto-assign   → { paused, teams: [{team_id, name, mode, paused}] }
// PATCH /api/helpdesk/me/auto-assign   { paused: boolean } pause or resume auto-assignment in every team
// An agent opting out of round robin and load balancing for a while (their tickets stay theirs; rules
// that name them and the on-call rota still reach them). Helpdesk 1.19.0 (agent N). Any desk agent.
// Audited as helpdesk.assignment.member_paused.

import { NextResponse } from "next/server";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { auditAssignment, badRequest } from "@/lib/helpdesk/assignment/routes";
import { myAutoAssign, setPausedEverywhere } from "@/lib/helpdesk/assignment/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await myAutoAssign(gate.id));
}

export async function PATCH(req: Request) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 512);
  if (!b || typeof b.paused !== "boolean") return badRequest("Send { paused: true } or { paused: false }.");
  const before = await myAutoAssign(gate.id);
  const teams = await setPausedEverywhere(gate.id, b.paused ? 1 : 0);
  if (before.paused !== b.paused || before.teams.some((t) => (t.paused === 1) !== b.paused)) {
    await auditAssignment(req, gate, "helpdesk.assignment.member_paused", { type: "user", id: gate.id, label: gate.name }, { paused: b.paused, team_ids: teams, self: true });
  }
  return NextResponse.json(await myAutoAssign(gate.id));
}

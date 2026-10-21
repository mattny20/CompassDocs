import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { actorFrom, audit, ipFrom } from "@/lib/audit";
import { createPolicySet, listPolicySets, policySetCandidates, PolicySetError } from "@/lib/db";
import { parseSetInput } from "@/lib/policy-sets";
import type { PolicySetRow } from "@/lib/types";

export const dynamic = "force-dynamic";

// Policy sets (D3, 1.14.0): named, ordered bundles of policies assigned to
// people, groups or everyone as one unit, and to every new account when
// they auto-assign.
//
//   GET  → { rows: PolicySetRow[], candidates: [{ id, title, space_name, space_icon, ack_required }] }
//          every set (active first) with its ordered members and progress,
//          plus the published documents a set may hold (the picker).
//   POST { name, description?, doc_ids, assign_new_members? } → 201 { set }
//          400 with the first problem named (lib/policy-sets parseSetInput),
//          409 "A set with that name exists." (case-insensitively, among
//          active sets). Nothing is assigned by creating a set. Audited as
//          ack.set_created {set, set_id, policies, assign_new_members}.
//
// Gated like the rest of the portal: the Compliance section and
// compliance.program_read to look, compliance.program_manage to write
// (complianceGuard), then the policy_ack licence (402).

const LICENCE = { error: "Read confirmations are not included in your license." };

export async function GET() {
  const gate = await complianceGuard("compliance.program_read");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("policy_ack"))) return NextResponse.json(LICENCE, { status: 402 });
  const [rows, candidates] = await Promise.all([listPolicySets(), policySetCandidates()]);
  return NextResponse.json({ rows, candidates }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await complianceGuard("compliance.program_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate;
  if (!(await featureEnabled("policy_ack"))) return NextResponse.json(LICENCE, { status: 402 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = parseSetInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let set: PolicySetRow;
  try {
    set = await createPolicySet(parsed.value, { id: user.id, name: user.name || user.username });
  } catch (e) {
    if (e instanceof PolicySetError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  await audit({
    actor: actorFrom(user),
    action: "ack.set_created",
    targetType: "policy_set",
    targetId: set.id,
    targetLabel: set.name,
    details: {
      set: set.name,
      set_id: set.id,
      policies: set.docs.length,
      doc_ids: set.docs.map((d) => d.id),
      assign_new_members: set.assign_new_members === 1,
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ set }, { status: 201 });
}

import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { actorFrom, audit, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import { assignPolicySet, deletePolicySet, getPolicySet, updatePolicySet, PolicySetError } from "@/lib/db";
import { parseSetPatch, parseSetTarget, SET_NOT_FOUND } from "@/lib/policy-sets";
import type { PolicySetAssignResult, PolicySetRow, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// One policy set (D3, 1.14.0).
//
//   PATCH  { name?, description?, doc_ids?, assign_new_members?, active? }
//          → { set }; `doc_ids` replaces the members in the given order;
//          `active: false` deactivates (reversible: auto-assign and
//          assignment stop, every rule and row stays), `active: true`
//          reactivates. 400 with the first problem named, 404 for an unknown
//          set, 409 "A set with that name exists.". Audited as
//          ack.set_deactivated when the set goes inactive, else
//          ack.set_updated {set, changed}.
//   DELETE → { ok: true }. The rules the set wrote stay (untagged) and so
//          does every assignment row: policies and confirmations stay, only
//          the set is removed. 404 unknown. Audited as ack.set_deleted.
//   POST   { user_ids?, group_ids?, everyone? } → assign the set:
//          { ok, policies, people, added, switched_on, not_narrowed }.
//          Every member policy gets the same include rules (or space mode
//          for everyone) and is reconciled; a member not yet requiring
//          confirmation is switched on with the defaults (`switched_on`);
//          one already asking everyone who can see its space is left alone
//          (`not_narrowed`). Up to 200 ids each; 400 with the problem named
//          (empty target: "Name at least one person or group, or assign to
//          everyone."), 404 unknown, 409 "This set is deactivated.
//          Reactivate it to assign it.". Audited as ack.set_assigned
//          {set, people, policies, switched_on, not_narrowed, everyone,
//          user_ids, group_ids}.
//
// All three need the Compliance section and compliance.program_manage
// (complianceGuard), then the policy_ack licence (402).

const LICENCE = { error: "Read confirmations are not included in your license." };

type Ctx = { params: Promise<{ id: string }> };

async function gated(ctx: Ctx): Promise<{ denied: NextResponse } | { user: SessionUser; id: number }> {
  const gate = await complianceGuard("compliance.program_manage");
  if (gate instanceof NextResponse) return { denied: gate };
  if (!(await featureEnabled("policy_ack"))) return { denied: NextResponse.json(LICENCE, { status: 402 }) };
  const { id } = await ctx.params;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return { denied: NextResponse.json({ error: SET_NOT_FOUND }, { status: 404 }) };
  return { user: gate, id: n };
}

async function jsonBody(req: Request): Promise<{ body: unknown } | { denied: NextResponse }> {
  try {
    return { body: await req.json() };
  } catch {
    return { denied: NextResponse.json({ error: "Invalid JSON." }, { status: 400 }) };
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const g = await gated(ctx);
  if ("denied" in g) return g.denied;
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const parsed = parseSetPatch(b.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let changed: { before: PolicySetRow; after: PolicySetRow } | null;
  try {
    changed = await updatePolicySet(g.id, parsed.value);
  } catch (e) {
    if (e instanceof PolicySetError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!changed) return NextResponse.json({ error: SET_NOT_FOUND }, { status: 404 });
  const { before, after } = changed;
  const deactivated = before.active === 1 && after.active === 0;
  await audit({
    actor: actorFrom(g.user),
    action: deactivated ? "ack.set_deactivated" : "ack.set_updated",
    targetType: "policy_set",
    targetId: after.id,
    targetLabel: after.name,
    details: {
      set: after.name,
      set_id: after.id,
      changed: Object.keys(parsed.value),
      policies: after.docs.length,
      active: after.active === 1,
      assign_new_members: after.assign_new_members === 1,
      ...(parsed.value.name !== undefined && before.name !== after.name ? { renamed_from: before.name } : {}),
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ set: after });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await gated(ctx);
  if ("denied" in g) return g.denied;
  const gone = await deletePolicySet(g.id);
  if (!gone) return NextResponse.json({ error: SET_NOT_FOUND }, { status: 404 });
  await audit({
    actor: actorFrom(g.user),
    action: "ack.set_deleted",
    targetType: "policy_set",
    targetId: g.id,
    targetLabel: gone.name,
    details: { set: gone.name, set_id: g.id, policies: gone.policies },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, ctx: Ctx) {
  const g = await gated(ctx);
  if ("denied" in g) return g.denied;
  const b = await jsonBody(req);
  if ("denied" in b) return b.denied;
  const parsed = parseSetTarget(b.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const actor = { id: g.user.id, name: g.user.name || g.user.username };
  let result: PolicySetAssignResult;
  let setName = "";
  try {
    const set = await getPolicySet(g.id);
    if (!set) return NextResponse.json({ error: SET_NOT_FOUND }, { status: 404 });
    setName = set.name;
    result = await assignPolicySet(g.id, parsed.value, actor, { origin: requestOrigin(req) });
  } catch (e) {
    if (e instanceof PolicySetError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  await audit({
    actor: actorFrom(g.user),
    action: "ack.set_assigned",
    targetType: "policy_set",
    targetId: g.id,
    targetLabel: setName,
    details: {
      set: setName,
      set_id: g.id,
      people: result.people,
      policies: result.policies,
      added: result.added,
      switched_on: result.switched_on,
      not_narrowed: result.not_narrowed,
      everyone: parsed.value.everyone,
      user_ids: parsed.value.user_ids,
      group_ids: parsed.value.group_ids,
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, ...result });
}

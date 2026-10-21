import { NextResponse } from "next/server";
import { complianceGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { listGroupLeads, listGroups, listUsers, setGroupLeads } from "@/lib/db";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Team leads from the compliance side (F4, 1.14.0): the same group_leads
// table /api/training/leads manages, reachable by a compliance manager who
// need not hold the Training section or its licence (the shared Team leads
// block on the compliance Overview reads and writes here). GET answers the
// groups, the leads, the people to pick from and whether Program settings
// let leads see policy standing; PUT { group_id, user_ids } replaces one
// group's leads and audits training.leads_set with `via: "compliance"`, the
// key the training route writes, because the leads are one list.

async function licence(): Promise<NextResponse | null> {
  if (await featureEnabled("policy_ack")) return null;
  return NextResponse.json({ error: "Read confirmations are not included in your license." }, { status: 402 });
}

export async function GET() {
  const gate = await complianceGuard("compliance.program_read");
  if (gate instanceof NextResponse) return gate;
  const denied = await licence();
  if (denied) return denied;
  const [groups, leads, users, settings] = await Promise.all([listGroups(), listGroupLeads(), listUsers(), getComplianceSettings()]);
  return NextResponse.json(
    {
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      leads,
      users: users
        .filter((u) => u.status === "active")
        // The username when an account has no display name, as every other picker falls back (an empty option reads as nobody).
        .map((u) => ({ id: u.id, label: u.name || u.username, sublabel: `${u.username} · ${u.role}` })),
      leads_see_policies: settings.ack_defaults.leads_see_policies,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PUT(req: Request) {
  const gate = await complianceGuard("compliance.program_manage");
  if (gate instanceof NextResponse) return gate;
  const denied = await licence();
  if (denied) return denied;
  const user = gate as SessionUser;
  const body = (await req.json().catch(() => ({}))) as { group_id?: unknown; user_ids?: unknown };
  const groupId = Number(body.group_id);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return NextResponse.json({ error: "group_id is required." }, { status: 400 });
  }
  if (!(await listGroups()).some((g) => g.id === groupId)) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  const userIds = Array.isArray(body.user_ids)
    ? (body.user_ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50)
    : [];
  await setGroupLeads(groupId, userIds);
  await audit({
    actor: actorFrom(user),
    action: "training.leads_set",
    details: { group_id: groupId, leads: userIds.length, via: "compliance" },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

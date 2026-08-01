import { NextResponse } from "next/server";
import { sectionApiGuard } from "@/lib/api-auth";
import { featureEnabled } from "@/lib/ee";
import { listGroupLeads, setGroupLeads, listGroups } from "@/lib/db";
import { audit, actorFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Team leads: who gets the scoped /training/team view (and the weekly
// digest) for each group. Managed by training managers.
export async function GET() {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const [groups, leads] = await Promise.all([listGroups(), listGroupLeads()]);
  return NextResponse.json({
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    leads,
  });
}

export async function PUT(req: Request) {
  const gate = await sectionApiGuard("training");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("training"))) {
    return NextResponse.json(
      { error: "Training is not included in your license." },
      { status: 402 }
    );
  }
  const user = gate as SessionUser;
  const body = (await req.json().catch(() => ({}))) as {
    group_id?: number;
    user_ids?: number[];
  };
  const groupId = Number(body.group_id);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return NextResponse.json({ error: "group_id is required." }, { status: 400 });
  }
  const userIds = Array.isArray(body.user_ids)
    ? body.user_ids.map(Number).filter(Number.isInteger).slice(0, 50)
    : [];
  await setGroupLeads(groupId, userIds);
  await audit({
    actor: actorFrom(user),
    action: "training.leads_set",
    details: { group_id: groupId, leads: userIds.length },
  });
  return NextResponse.json({ ok: true });
}

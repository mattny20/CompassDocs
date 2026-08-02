import { NextResponse } from "next/server";
import { listRoleAssignments, assignRole } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";
import { roleMutationError } from "../errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await apiGuard("admin", "role.read");
  if (gate instanceof NextResponse) return gate;
  const roleId = Number(new URL(req.url).searchParams.get("role_id"));
  return NextResponse.json({
    assignments: await listRoleAssignments(Number.isInteger(roleId) && roleId > 0 ? roleId : undefined),
  });
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "role.assign");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const body = await req.json().catch(() => ({}));
  const roleId = Number(body?.role_id);
  const userId = body?.user_id === undefined || body?.user_id === null ? undefined : Number(body.user_id);
  const groupId = body?.group_id === undefined || body?.group_id === null ? undefined : Number(body.group_id);
  const spaceId = body?.space_id === undefined || body?.space_id === null ? undefined : Number(body.space_id);
  if (!Number.isInteger(roleId)) {
    return NextResponse.json({ error: "A role is required." }, { status: 400 });
  }
  if ((userId === undefined) === (groupId === undefined)) {
    return NextResponse.json({ error: "Pick exactly one person or group." }, { status: 400 });
  }

  const result = await assignRole({ roleId, userId, groupId, spaceId });
  if ("error" in result) return roleMutationError(result.error);

  await audit({
    actor: actorFrom(user),
    action: "role.assigned",
    targetType: "role",
    targetId: roleId,
    details: { user_id: userId ?? null, group_id: groupId ?? null, space_id: spaceId ?? null },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}

import { NextResponse } from "next/server";
import { unassignRole } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";
import { roleMutationError } from "../../errors";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "role.assign");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const id = Number((await params).id);
  const result = await unassignRole(id);
  if ("error" in result) return roleMutationError(result.error);

  await audit({
    actor: actorFrom(user),
    action: "role.unassigned",
    targetType: "role_assignment",
    targetId: id,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

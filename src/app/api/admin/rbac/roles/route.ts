import { NextResponse } from "next/server";
import { listRolesWithCounts, createRole, listRoleAssignments } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SessionUser } from "@/lib/types";
import { roleMutationError } from "../errors";

export const dynamic = "force-dynamic";

// The role catalog, the permission catalog the editor renders, and the
// assignments binding roles to people. One request because the console needs
// all three before it can draw anything, and all three are small.
export async function GET() {
  const gate = await apiGuard("admin", "role.read");
  if (gate instanceof NextResponse) return gate;
  const [roles, assignments] = await Promise.all([listRolesWithCounts(), listRoleAssignments()]);
  return NextResponse.json({ roles, assignments, permissions: PERMISSIONS });
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "role.manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name.trim()) return NextResponse.json({ error: "A name is required." }, { status: 400 });

  const result = await createRole({
    name,
    description: typeof body?.description === "string" ? body.description : "",
    permissions: Array.isArray(body?.permissions) ? body.permissions : [],
    copyFromRoleId: Number.isInteger(body?.copy_from) ? body.copy_from : undefined,
  });
  if ("error" in result) return roleMutationError(result.error);

  await audit({
    actor: actorFrom(user),
    action: "role.created",
    targetType: "role",
    targetId: result.id,
    targetLabel: name.trim(),
    details: { copied_from: body?.copy_from ?? null },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
}

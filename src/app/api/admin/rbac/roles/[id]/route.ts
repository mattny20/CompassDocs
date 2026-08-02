import { NextResponse } from "next/server";
import { getRoleDetail, updateRole, deleteRole } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";
import { roleMutationError } from "../../errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "role.read");
  if (gate instanceof NextResponse) return gate;
  const role = await getRoleDetail(Number((await params).id));
  if (!role) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ role });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "role.manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const id = Number((await params).id);
  const before = await getRoleDetail(id);
  if (!before) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const result = await updateRole(id, {
    name: typeof body?.name === "string" ? body.name : undefined,
    description: typeof body?.description === "string" ? body.description : undefined,
    permissions: Array.isArray(body?.permissions) ? body.permissions : undefined,
  });
  if ("error" in result) return roleMutationError(result.error);

  const after = await getRoleDetail(id);
  // The audit entry records the delta, not the whole set: "who was granted the
  // ability to purge documents, and when" is the question this log gets asked.
  const added = after?.permissions.filter((p) => !before.permissions.includes(p)) ?? [];
  const removed = before.permissions.filter((p) => !(after?.permissions ?? []).includes(p));
  await audit({
    actor: actorFrom(user),
    action: "role.updated",
    targetType: "role",
    targetId: id,
    targetLabel: after?.name ?? before.name,
    details: { added, removed },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, role: after });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "role.manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  const id = Number((await params).id);
  const before = await getRoleDetail(id);
  const result = await deleteRole(id);
  if ("error" in result) return roleMutationError(result.error);

  await audit({
    actor: actorFrom(user),
    action: "role.deleted",
    targetType: "role",
    targetId: id,
    targetLabel: before?.name ?? String(id),
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

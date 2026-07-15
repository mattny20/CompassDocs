import { NextResponse } from "next/server";
import {
  getGroup,
  renameGroup,
  deleteGroup,
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  getUserById,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

function memberView(u: User) {
  return { id: u.id, username: u.username, name: u.name, email: u.email, role: u.role };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  const group = Number.isInteger(id) ? await getGroup(id) : undefined;
  if (!group) return NextResponse.json({ error: "Group not found." }, { status: 404 });

  const members = (await listGroupMembers(id)).map(memberView);
  return NextResponse.json({ group, members });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  const group = Number.isInteger(id) ? await getGroup(id) : undefined;
  if (!group) return NextResponse.json({ error: "Group not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Rename (manual groups only — Entra-synced groups keep their directory name).
  if (body?.name !== undefined) {
    if (group.source !== "manual") {
      return NextResponse.json(
        { error: "Synced groups are renamed in the directory, not here." },
        { status: 400 }
      );
    }
    const name = String(body.name).trim();
    if (name.length < 2 || name.length > 80) {
      return NextResponse.json({ error: "Group name must be 2–80 characters." }, { status: 400 });
    }
    await renameGroup(id, name);
    await audit({
      actor: actorFrom(gate),
      action: "group.rename",
      targetType: "group",
      targetId: id,
      targetLabel: name,
      details: { from: group.name },
      ip: ipFrom(req),
    });
  }

  // Membership changes. Manual edits are allowed on synced groups too (they'll
  // be overwritten on the next sync — the UI warns about this).
  const addId = Number(body?.addUserId);
  if (Number.isInteger(addId) && addId > 0) {
    const target = await getUserById(addId);
    if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
    await addGroupMember(id, addId);
    await audit({
      actor: actorFrom(gate),
      action: "group.member_add",
      targetType: "group",
      targetId: id,
      targetLabel: group.name,
      details: { user: target.username },
      ip: ipFrom(req),
    });
  }
  const removeId = Number(body?.removeUserId);
  if (Number.isInteger(removeId) && removeId > 0) {
    const target = await getUserById(removeId);
    await removeGroupMember(id, removeId);
    await audit({
      actor: actorFrom(gate),
      action: "group.member_remove",
      targetType: "group",
      targetId: id,
      targetLabel: group.name,
      details: { user: target?.username ?? String(removeId) },
      ip: ipFrom(req),
    });
  }

  const members = (await listGroupMembers(id)).map(memberView);
  return NextResponse.json({ group: await getGroup(id), members });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  const group = Number.isInteger(id) ? await getGroup(id) : undefined;
  if (!group) return NextResponse.json({ error: "Group not found." }, { status: 404 });

  await deleteGroup(id);
  await audit({
    actor: actorFrom(gate),
    action: "group.delete",
    targetType: "group",
    targetId: id,
    targetLabel: group.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

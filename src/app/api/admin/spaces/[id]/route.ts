import { NextResponse } from "next/server";
import {
  updateSpace,
  deleteSpace,
  getSpaceById,
  setSpaceGroups,
  getSpaceGroupIds,
  setSpaceSubscriptionGroups,
} from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || !(await getSpaceById(id))) {
    return NextResponse.json({ error: "Space not found." }, { status: 404 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const patch: {
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    visibility?: string;
  } = {};
  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 2 || name.length > 60) {
      return NextResponse.json({ error: "Space name must be 2–60 characters." }, { status: 400 });
    }
    patch.name = name;
  }
  if (body?.description !== undefined) patch.description = String(body.description).trim().slice(0, 280);
  if (body?.icon !== undefined) patch.icon = String(body.icon).trim().slice(0, 8) || "📁";
  if (body?.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(body.color)) {
      return NextResponse.json({ error: "Color must be a hex value like #2e75bd." }, { status: 400 });
    }
    patch.color = body.color;
  }
  if (body?.visibility !== undefined) {
    if (!["public", "internal", "private"].includes(body.visibility)) {
      return NextResponse.json(
        { error: "Visibility must be public, internal, or private." },
        { status: 400 }
      );
    }
    patch.visibility = body.visibility;
  }

  const space = await updateSpace(id, patch);

  // Group grants only matter for private spaces; leaving the private tier
  // clears them so a later flip back starts from an explicit empty grant.
  let groupIds: number[] | undefined;
  if (space && space.visibility !== "private") {
    await setSpaceGroups(id, []);
    groupIds = [];
  } else if (Array.isArray(body?.groupIds)) {
    groupIds = body.groupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
    await setSpaceGroups(id, groupIds!);
  } else {
    groupIds = await getSpaceGroupIds(id);
  }

  if (Array.isArray(body?.subscriptionGroupIds)) {
    await setSpaceSubscriptionGroups(
      id,
      body.subscriptionGroupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    );
  }

  await audit({
    actor: actorFrom(gate),
    action: "space.update",
    targetType: "space",
    targetId: id,
    targetLabel: space?.name,
    details: {
      fields: Object.keys(patch).concat(Array.isArray(body?.groupIds) ? ["groups"] : []),
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ space, groupIds });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const id = Number((await params).id);
  const existing = Number.isInteger(id) ? await getSpaceById(id) : undefined;
  if (!existing) {
    return NextResponse.json({ error: "Space not found." }, { status: 404 });
  }

  const res = await deleteSpace(id);
  if (!res.ok) {
    return NextResponse.json(
      {
        error: `This space still has ${res.docCount} document${res.docCount === 1 ? "" : "s"}. Move or delete them first.`,
      },
      { status: 409 }
    );
  }
  await audit({
    actor: actorFrom(gate),
    action: "space.delete",
    targetType: "space",
    targetId: id,
    targetLabel: existing.name,
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

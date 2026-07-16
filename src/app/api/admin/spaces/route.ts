import { NextResponse } from "next/server";
import {
  listSpaces,
  createSpace,
  uniqueSpaceSlug,
  listAllSpaceGroups,
  setSpaceGroups,
  listAllSpaceSubscriptionGroups,
  setSpaceSubscriptionGroups,
  listAllSpaceEditorGrants,
  setSpaceEditors,
  setSpaceEditorGroups,
  setSetting,
} from "@/lib/db";
import { editorsEditAll } from "@/lib/access";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

const cleanIds = (v: unknown) =>
  Array.isArray(v) ? v.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : undefined;

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({
    spaces: await listSpaces(),
    spaceGroups: await listAllSpaceGroups(),
    subscriptionGroups: await listAllSpaceSubscriptionGroups(),
    editorGrants: await listAllSpaceEditorGrants(),
    editorsEditAll: await editorsEditAll(),
  });
}

// Org-level switch: editors_edit_all — when on (default), any editor may edit
// any space they can see and per-space grants are ignored.
export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body?.editorsEditAll !== "boolean") {
    return NextResponse.json({ error: "editorsEditAll must be true or false." }, { status: 400 });
  }
  await setSetting("editors_edit_all", body.editorsEditAll ? "1" : "0");
  await audit({
    actor: actorFrom(gate),
    action: "settings.editors_edit_all",
    details: { enabled: body.editorsEditAll },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, editorsEditAll: body.editorsEditAll });
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const name = String(body?.name ?? "").trim();
  if (name.length < 2 || name.length > 60) {
    return NextResponse.json({ error: "Space name must be 2–60 characters." }, { status: 400 });
  }

  const slug = await uniqueSpaceSlug(name);
  const visibility = ["public", "internal", "private"].includes(body?.visibility)
    ? body.visibility
    : "internal";
  const space = await createSpace({
    slug,
    name,
    description: String(body?.description ?? "").trim().slice(0, 280),
    icon: String(body?.icon ?? "").trim().slice(0, 8) || "📁",
    color: /^#[0-9a-fA-F]{6}$/.test(body?.color) ? body.color : "#2e75bd",
    visibility,
  });
  if (visibility === "private" && Array.isArray(body?.groupIds)) {
    await setSpaceGroups(
      space.id,
      body.groupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    );
  }
  if (Array.isArray(body?.subscriptionGroupIds)) {
    await setSpaceSubscriptionGroups(
      space.id,
      body.subscriptionGroupIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    );
  }
  const editorUserIds = cleanIds(body?.editorUserIds);
  const editorGroupIds = cleanIds(body?.editorGroupIds);
  if (editorUserIds) await setSpaceEditors(space.id, editorUserIds);
  if (editorGroupIds) await setSpaceEditorGroups(space.id, editorGroupIds);
  await audit({
    actor: actorFrom(gate),
    action: "space.create",
    targetType: "space",
    targetId: space.id,
    targetLabel: space.name,
    details: { visibility },
    ip: ipFrom(req),
  });
  return NextResponse.json({ space }, { status: 201 });
}

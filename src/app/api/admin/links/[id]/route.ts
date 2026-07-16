import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getLink, updateLink, deleteLink, setLinkGroups, getLinkGroupIds } from "@/lib/db";
import { fetchFavicon } from "@/lib/favicon";
import { deleteUpload } from "@/lib/uploads";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ICON_TYPES = ["favicon", "brand", "custom"] as const;

function validUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const link = await getLink(Number(id));
  if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const patch: Parameters<typeof updateLink>[1] = {};
  if (typeof body?.title === "string" && body.title.trim()) patch.title = body.title;
  if (typeof body?.description === "string") patch.description = body.description;
  if (body?.category_id === null || Number.isInteger(body?.category_id)) {
    patch.category_id = body.category_id;
  }
  if (Number.isInteger(body?.position)) patch.position = body.position;
  if (typeof body?.url === "string") {
    const url = validUrl(body.url);
    if (!url) return NextResponse.json({ error: "Enter a valid http(s) URL." }, { status: 400 });
    patch.url = url;
  }
  if (body?.icon_type !== undefined) {
    if (!ICON_TYPES.includes(body.icon_type)) {
      return NextResponse.json({ error: "Unknown icon type." }, { status: 400 });
    }
    patch.icon_type = body.icon_type;
  }

  const nextType = patch.icon_type ?? link.icon_type;
  const urlChanged = patch.url !== undefined && patch.url !== link.url;

  // Re-fetch the favicon when the link now wants one and either asked for a
  // refresh, points somewhere new, or never had one cached.
  if (
    nextType === "favicon" &&
    (body?.refresh_icon === true || urlChanged || link.icon_type !== "favicon" || !link.icon_file)
  ) {
    const icon = await fetchFavicon(patch.url ?? link.url);
    patch.icon_file = icon?.stored ?? null;
    patch.icon_mime = icon?.mime ?? null;
  }
  // Switching favicon → brand drops the cached file; a custom upload is kept
  // so flipping back and forth doesn't lose it (replaced via the icon route).
  if (nextType === "brand" && link.icon_type === "favicon") {
    patch.icon_file = null;
    patch.icon_mime = null;
  }

  // Clean up a cached favicon we're abandoning or replacing.
  if (
    link.icon_file &&
    link.icon_type === "favicon" &&
    patch.icon_file !== undefined &&
    patch.icon_file !== link.icon_file
  ) {
    await deleteUpload(link.icon_file);
  }

  const updated = await updateLink(link.id, patch);

  let groupIds = await getLinkGroupIds(link.id);
  if (Array.isArray(body?.group_ids)) {
    groupIds = body.group_ids.filter((g: unknown) => Number.isInteger(g));
    await setLinkGroups(link.id, groupIds);
  }

  await audit({
    actor: actorFrom(gate),
    action: "link.updated",
    targetLabel: updated?.title ?? link.title,
    details: { url: updated?.url ?? link.url, groups: groupIds.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ link: { ...updated, group_ids: groupIds } });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const row = await deleteLink(Number(id));
  if (!row) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  if (row.icon_file) await deleteUpload(row.icon_file);

  await audit({
    actor: actorFrom(gate),
    action: "link.deleted",
    targetLabel: row.title,
    details: { url: row.url },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

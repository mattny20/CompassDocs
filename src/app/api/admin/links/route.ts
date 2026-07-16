import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  listLinkCategories,
  listLinksVisibleTo,
  listAllLinkGroups,
  createLink,
  setLinkGroups,
} from "@/lib/db";
import { fetchFavicon } from "@/lib/favicon";
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

// Everything the Links admin screen needs in one call.
export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const [categories, links, groups] = await Promise.all([
    listLinkCategories(),
    listLinksVisibleTo("all"),
    listAllLinkGroups(),
  ]);
  return NextResponse.json({
    categories,
    links: links.map((l) => ({ ...l, group_ids: groups[l.id] ?? [] })),
  });
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

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const url = validUrl(typeof body?.url === "string" ? body.url : "");
  if (!title) return NextResponse.json({ error: "A title is required." }, { status: 400 });
  if (!url) {
    return NextResponse.json({ error: "Enter a valid http(s) URL." }, { status: 400 });
  }
  const iconType = ICON_TYPES.includes(body?.icon_type) ? body.icon_type : "favicon";

  // "Site icon" links get their favicon fetched and cached now; a miss is fine
  // (the card falls back to a letter tile, and the admin can retry or upload).
  let iconFile: string | null = null;
  let iconMime: string | null = null;
  if (iconType === "favicon") {
    const icon = await fetchFavicon(url);
    if (icon) {
      iconFile = icon.stored;
      iconMime = icon.mime;
    }
  }

  const link = await createLink({
    category_id: Number.isInteger(body?.category_id) ? body.category_id : null,
    title,
    url,
    description: typeof body?.description === "string" ? body.description : "",
    icon_type: iconType,
    icon_file: iconFile,
    icon_mime: iconMime,
  });

  const groupIds = Array.isArray(body?.group_ids)
    ? body.group_ids.filter((g: unknown) => Number.isInteger(g))
    : [];
  if (groupIds.length) await setLinkGroups(link.id, groupIds);

  await audit({
    actor: actorFrom(gate),
    action: "link.created",
    targetLabel: title,
    details: { url, groups: groupIds.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ link: { ...link, group_ids: groupIds } });
}

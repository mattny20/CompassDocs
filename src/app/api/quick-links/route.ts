// The viewer's own dashboard pins (1.17.0, the Quick links tile):
//
//   GET   → { pinned: QuickLinkItem[] }
//   POST  { linkId }        pin a curated link the viewer can see
//         { title, url }    pin their own link (http(s) only)
//         → 201 { item }; 409 when they already keep twelve
//
// Pins are personal, so nothing here is audited. A curated pin whose link
// stops being visible is kept but not shown (lib/quick-links).

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { addUserQuickLink, getLink, linkVisibleTo, MAX_USER_QUICK_LINKS } from "@/lib/db";
import { getPinnedQuickLinks, validOwnLinkUrl } from "@/lib/quick-links";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const TITLE_MAX = 60;

export async function GET() {
  const gate = await apiGuard("viewer", "link.read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ pinned: await getPinnedQuickLinks(gate as SessionUser) });
}

export async function POST(req: Request) {
  const gate = await apiGuard("viewer", "link.read");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: { linkId?: unknown; title?: unknown; url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let pin: { linkId: number } | { title: string; url: string };
  if (body?.linkId !== undefined) {
    const linkId = Number(body.linkId);
    const link = Number.isInteger(linkId) ? await getLink(linkId) : undefined;
    if (!link || (user.role !== "admin" && !(await linkVisibleTo(link.id, user.id)))) {
      return NextResponse.json({ error: "That link is not available." }, { status: 404 });
    }
    pin = { linkId: link.id };
  } else {
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "Give the link a title." }, { status: 400 });
    if (title.length > TITLE_MAX) {
      return NextResponse.json({ error: `Keep the title to ${TITLE_MAX} characters.` }, { status: 400 });
    }
    const url = validOwnLinkUrl(typeof body?.url === "string" ? body.url : "");
    if (!url) {
      return NextResponse.json(
        { error: "Enter a web address that starts with https:// or http://." },
        { status: 400 }
      );
    }
    pin = { title, url };
  }

  const row = await addUserQuickLink(user.id, pin);
  if (!row) {
    return NextResponse.json(
      { error: `You can pin up to ${MAX_USER_QUICK_LINKS} links. Remove one to add another.` },
      { status: 409 }
    );
  }
  const item = (await getPinnedQuickLinks(user)).find((p) => p.pinId === row.id);
  return NextResponse.json({ item }, { status: 201 });
}

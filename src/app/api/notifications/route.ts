import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  listNotificationsFor,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/db";

export const dynamic = "force-dynamic";

/** The signed-in user's notification inbox: recent items + unread count.
 *  Paging is opt-in: ?before=<id> returns rows older than that id and
 *  ?limit= (1–100, default 30) sizes the page; `more` says whether another
 *  page exists. The default call keeps its shape for the bell. */
export async function GET(req: Request) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const before = Number(url.searchParams.get("before"));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const [items, unread] = await Promise.all([
    listNotificationsFor(gate.id, limit + 1, Number.isInteger(before) && before > 0 ? before : undefined),
    unreadNotificationCount(gate.id),
  ]);
  const more = items.length > limit;
  return NextResponse.json({ items: more ? items.slice(0, limit) : items, unread, more });
}

/** Mark one ({action:"read", id}) or all ({action:"read_all"}) as read. */
export async function POST(req: Request) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  let body: { action?: unknown; id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (body.action === "read_all") {
    await markAllNotificationsRead(gate.id);
  } else if (body.action === "read" && Number.isInteger(Number(body.id))) {
    await markNotificationRead(gate.id, Number(body.id));
  } else {
    return NextResponse.json({ error: "action must be 'read' or 'read_all'." }, { status: 400 });
  }
  return NextResponse.json({ unread: await unreadNotificationCount(gate.id) });
}

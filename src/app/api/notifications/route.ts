import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  listNotificationsFor,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/db";

export const dynamic = "force-dynamic";

/** The signed-in user's notification inbox: recent items + unread count. */
export async function GET() {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const [items, unread] = await Promise.all([
    listNotificationsFor(gate.id, 30),
    unreadNotificationCount(gate.id),
  ]);
  return NextResponse.json({ items, unread });
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

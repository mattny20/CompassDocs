import { NextResponse } from "next/server";
import { getUserById, listSubscriptionsForUser, setEmailNotifications } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const [me, subscriptions] = await Promise.all([
    getUserById(user.id),
    listSubscriptionsForUser(user.id),
  ]);
  return NextResponse.json({
    email: me?.email ?? "",
    email_notifications: me?.email_notifications === 1,
    subscriptions,
  });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body?.email_notifications === "boolean") {
    await setEmailNotifications(user.id, body.email_notifications);
  }
  return NextResponse.json({ ok: true });
}

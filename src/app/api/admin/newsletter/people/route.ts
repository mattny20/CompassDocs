import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listUsers, getUserById, setUserNewsletterRole } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Admin roster for the newsletter module: who can contribute, who can approve.

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const users = (await listUsers()).map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    newsletter_role: u.newsletter_role,
  }));
  return NextResponse.json({ users });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const userId = Number(body?.user_id);
  const role = body?.newsletter_role;
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "user_id is required." }, { status: 400 });
  }
  if (role !== "none" && role !== "contributor" && role !== "approver") {
    return NextResponse.json(
      { error: "newsletter_role must be none, contributor, or approver." },
      { status: 400 }
    );
  }
  const target = await getUserById(userId);
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  await setUserNewsletterRole(userId, role);
  await audit({
    actor: actorFrom(admin),
    action: "newsletter.role_changed",
    targetType: "user",
    targetId: userId,
    targetLabel: target.username,
    details: { newsletter_role: role },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

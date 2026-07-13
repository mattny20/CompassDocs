import { NextResponse } from "next/server";
import { createUser, getUserByUsername } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { ROLE_ORDER } from "@/lib/types";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const role = body?.role as Role;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json(
      { error: "Username must be 3–32 chars: letters, numbers, dot, dash, underscore." },
      { status: 400 }
    );
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Temporary password must be at least 6 characters." }, { status: 400 });
  }
  if (!ROLE_ORDER.includes(role)) {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }
  if (await getUserByUsername(username)) {
    return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
  }

  const { hash, salt } = hashPassword(password);
  const user = await createUser({
    username,
    name: String(body?.name ?? "").trim() || username,
    email: String(body?.email ?? "").trim(),
    role,
    passwordHash: hash,
    passwordSalt: salt,
    mustChange: true,
  });
  await audit({
    actor: actorFrom(gate),
    action: "user.create",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.username,
    details: { role },
    ip: ipFrom(req),
  });
  return NextResponse.json({ user }, { status: 201 });
}

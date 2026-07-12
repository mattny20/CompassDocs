import { NextResponse } from "next/server";
import {
  getUserById,
  updateUser,
  setUserPassword,
  deleteUser,
  countAdmins,
  deleteUserSessions,
} from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { apiGuard } from "@/lib/api-auth";
import { ROLE_ORDER } from "@/lib/types";
import type { Role, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  const { id } = await params;
  const target = getUserById(Number(id));
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Password reset (issues a new temp password requiring change on next login).
  if (typeof body?.resetPassword === "string") {
    if (body.resetPassword.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }
    const { hash, salt } = hashPassword(body.resetPassword);
    setUserPassword(target.id, hash, salt, true);
    deleteUserSessions(target.id); // force re-login with the new password
    return NextResponse.json({ ok: true });
  }

  const role = body?.role as Role | undefined;
  const status = body?.status as "active" | "disabled" | undefined;
  if (role !== undefined && !ROLE_ORDER.includes(role)) {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  // Never let the last active admin be demoted or disabled — avoids lockout.
  const demoting = role !== undefined && target.role === "admin" && role !== "admin";
  const disabling = status === "disabled" && target.role === "admin";
  if ((demoting || disabling) && countAdmins() <= 1) {
    return NextResponse.json({ error: "Can't remove the last admin." }, { status: 400 });
  }

  const updated = updateUser(target.id, { role, status });
  if (status === "disabled") deleteUserSessions(target.id);
  return NextResponse.json({ user: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  const { id } = await params;
  const target = getUserById(Number(id));
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.id === admin.id) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }
  if (target.role === "admin" && countAdmins() <= 1) {
    return NextResponse.json({ error: "Can't delete the last admin." }, { status: 400 });
  }

  deleteUser(target.id);
  return NextResponse.json({ ok: true });
}

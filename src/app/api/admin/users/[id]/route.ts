import { NextResponse } from "next/server";
import {
  getUserById,
  updateUser,
  setUserPassword,
  deleteUser,
  countAdmins,
  deleteUserSessions,
  disableTotp,
} from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { ROLE_ORDER } from "@/lib/types";
import type { Role, SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  const { id } = await params;
  const target = await getUserById(Number(id));
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
    await setUserPassword(target.id, hash, salt, true);
    await deleteUserSessions(target.id); // force re-login with the new password
    await audit({
      actor: actorFrom(admin),
      action: "user.reset_password",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  }

  // 2FA reset — the admin escape hatch for a user who lost their authenticator
  // AND recovery codes. Clears the secret so they can sign in and re-enroll.
  if (body?.reset2fa === true) {
    await disableTotp(target.id);
    await audit({
      actor: actorFrom(admin),
      action: "user.reset_2fa",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      ip: ipFrom(req),
    });
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
  if ((demoting || disabling) && (await countAdmins()) <= 1) {
    return NextResponse.json({ error: "Can't remove the last admin." }, { status: 400 });
  }

  const updated = await updateUser(target.id, { role, status });
  if (status === "disabled") await deleteUserSessions(target.id);
  if (role !== undefined && role !== target.role) {
    await audit({
      actor: actorFrom(admin),
      action: "user.role_change",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      details: { from: target.role, to: role },
      ip: ipFrom(req),
    });
  }
  if (status !== undefined && status !== target.status) {
    await audit({
      actor: actorFrom(admin),
      action: status === "disabled" ? "user.disable" : "user.enable",
      targetType: "user",
      targetId: target.id,
      targetLabel: target.username,
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ user: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;

  const { id } = await params;
  const target = await getUserById(Number(id));
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.id === admin.id) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }
  if (target.role === "admin" && (await countAdmins()) <= 1) {
    return NextResponse.json({ error: "Can't delete the last admin." }, { status: 400 });
  }

  await deleteUser(target.id);
  await audit({
    actor: actorFrom(admin),
    action: "user.delete",
    targetType: "user",
    targetId: target.id,
    targetLabel: target.username,
    details: { role: target.role },
    ip: ipFrom(_req),
  });
  return NextResponse.json({ ok: true });
}

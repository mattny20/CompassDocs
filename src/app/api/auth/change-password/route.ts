import { NextResponse } from "next/server";
import { passwordProblem } from "@/lib/password-policy";
import { getCurrentUser } from "@/lib/auth";
import { getUserByUsername, setUserPassword } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { actorFrom, audit, ipFrom } from "@/lib/audit";
import { pairRetryAfter, recordLoginSuccess, recordPairFailure } from "@/lib/login-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const currentPassword = String(body?.currentPassword ?? "");
  const newPassword = String(body?.newPassword ?? "");
  const pwProblem = passwordProblem(newPassword);
  if (pwProblem) {
    return NextResponse.json({ error: `New ${pwProblem.charAt(0).toLowerCase()}${pwProblem.slice(1)}` }, { status: 400 });
  }

  const record = await getUserByUsername(sessionUser.username);
  if (!record || !record.password_hash || !record.password_salt) {
    return NextResponse.json({ error: "Account cannot change password here." }, { status: 400 });
  }
  // The current password is an oracle like the sign-in form's: throttled per
  // username and address, as the typed signature is (lib/login-guard). No
  // await between the check and the count, so a burst can't all pass it.
  const ip = ipFrom(req) || "unknown";
  const wait = pairRetryAfter(sessionUser.username, ip);
  if (wait > 0) {
    const minutes = Math.ceil(wait / 60);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }
  if (!verifyPassword(currentPassword, record.password_hash, record.password_salt)) {
    const lockEngaged = recordPairFailure(sessionUser.username, ip);
    await audit({
      actor: actorFrom(sessionUser),
      action: "auth.login_failed",
      targetType: "user",
      targetId: record.id,
      targetLabel: record.username,
      details: { via: "change_password" },
      ip,
    });
    if (lockEngaged) {
      await audit({
        actor: actorFrom(sessionUser),
        action: "auth.lockout",
        targetType: "user",
        targetId: record.id,
        targetLabel: record.username,
        details: { minutes: 15, via: "change_password" },
        ip,
      });
    }
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }
  recordLoginSuccess(sessionUser.username, ip);

  const { hash, salt } = hashPassword(newPassword);
  await setUserPassword(record.id, hash, salt, false);
  return NextResponse.json({ ok: true });
}

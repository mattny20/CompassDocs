import { NextResponse } from "next/server";
import { login, SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE, secureCookie } from "@/lib/auth";
import { audit, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const totpCode = typeof body?.totp_code === "string" ? body.totp_code : undefined;
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  const result = await login(username, password, totpCode, {
    ip: ipFrom(req),
    userAgent: req.headers.get("user-agent"),
  });
  if (!result) {
    await audit({
      actor: { name: username },
      action: "auth.login_failed",
      targetType: "user",
      targetLabel: username,
      ip: ipFrom(req),
    });
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  if ("totp_required" in result) {
    // Password was right. Ask for (or re-ask after a wrong) authenticator code;
    // don't audit as a failure — this is a normal step for 2FA accounts.
    return NextResponse.json(
      { totp_required: true, error: totpCode ? "That code didn't work — try again." : undefined },
      { status: 401 }
    );
  }

  await audit({
    actor: { id: result.user.id, name: result.user.name || result.user.username, role: result.user.role },
    action: "auth.login",
    ip: ipFrom(req),
  });

  const res = NextResponse.json({
    ok: true,
    must_change_password: result.user.must_change_password === 1,
  });
  res.cookies.set(SESSION_COOKIE, result.token, cookieOptions(SESSION_MAX_AGE, await secureCookie(req)));
  return res;
}

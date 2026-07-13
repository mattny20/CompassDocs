import { NextResponse } from "next/server";
import { login, SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE } from "@/lib/auth";
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
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  const result = await login(username, password);
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

  await audit({
    actor: { id: result.user.id, name: result.user.name || result.user.username, role: result.user.role },
    action: "auth.login",
    ip: ipFrom(req),
  });

  const res = NextResponse.json({
    ok: true,
    must_change_password: result.user.must_change_password === 1,
  });
  res.cookies.set(SESSION_COOKIE, result.token, cookieOptions(SESSION_MAX_AGE));
  return res;
}

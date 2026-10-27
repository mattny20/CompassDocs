import { NextResponse } from "next/server";
import { login, IDENTIFIER_MAX, SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE, secureCookie } from "@/lib/auth";
import { audit, ipFrom } from "@/lib/audit";
import { metric } from "@/lib/metrics";
import { beginLoginAttempt, refundLoginAttempt } from "@/lib/login-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Login CSRF: a browser declaring a foreign Origin can't start a session.
  const { crossOriginRejection } = await import("@/lib/api-auth");
  const cross = await crossOriginRejection();
  if (cross) return cross;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  // `username` is the field's name for compatibility; since 1.16.0 it may be
  // an email (lib/auth resolveSignInAccount).
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const totpCode = typeof body?.totp_code === "string" ? body.totp_code : undefined;
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }
  // Longer than any email can be: refused before the throttle, the account
  // read and the audit log, on its length alone.
  if (username.length > IDENTIFIER_MAX) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 400 });
  }

  const ip = ipFrom(req) || "unknown";

  // Throttle before touching the database or credentials: repeated failures
  // for this identifier+IP (or a spray from this IP) get a temporary lockout.
  // Keyed on what was typed, so a lock never depends on which account, if
  // any, an email belongs to. The attempt is counted here, in the same step
  // as the check, and given back below when it did not fail: counted after
  // the await, a burst sent at once all passed the check.
  const attempt = beginLoginAttempt(username, ip);
  if (attempt.wait > 0) {
    const wait = attempt.wait;
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.` },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }

  let result: Awaited<ReturnType<typeof login>>;
  try {
    result = await login(username, password, totpCode, {
      ip,
      userAgent: req.headers.get("user-agent"),
    });
  } catch (err) {
    // A database error is not a wrong password.
    refundLoginAttempt(attempt, false);
    throw err;
  }
  if (!result) {
    metric("login_failure");
    await audit({
      actor: { name: username },
      action: "auth.login_failed",
      targetType: "user",
      targetLabel: username,
      ip,
    });
    if (attempt.lockEngaged) {
      await audit({
        actor: { name: username },
        action: "auth.lockout",
        targetType: "user",
        targetLabel: username,
        details: { minutes: 15 },
        ip,
      });
    }
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  if ("totp_required" in result) {
    // Password was right. Ask for (or re-ask after a wrong) authenticator code;
    // a wrong code keeps its count so codes can't be brute-forced, and the
    // first step, with no code yet, gives its count back.
    if (totpCode) {
      // A wrong second factor is a failed sign-in on the record too (1.16.0),
      // and so is the lockout it engages.
      await audit({
        actor: { name: username },
        action: "auth.login_failed",
        targetType: "user",
        targetLabel: username,
        details: { stage: "two_factor" },
        ip,
      });
      if (attempt.lockEngaged) {
        await audit({
          actor: { name: username },
          action: "auth.lockout",
          targetType: "user",
          targetLabel: username,
          details: { minutes: 15, stage: "two_factor" },
          ip,
        });
      }
    } else {
      refundLoginAttempt(attempt, false);
    }
    return NextResponse.json(
      { totp_required: true, error: totpCode ? "That code didn't work — try again." : undefined },
      { status: 401 }
    );
  }

  metric("login_success");
  refundLoginAttempt(attempt, true);
  await audit({
    actor: { id: result.user.id, name: result.user.name || result.user.username, role: result.user.role },
    action: "auth.login",
    ip,
  });

  const res = NextResponse.json({
    ok: true,
    must_change_password: result.user.must_change_password === 1,
  });
  res.cookies.set(SESSION_COOKIE, result.token, cookieOptions(SESSION_MAX_AGE, await secureCookie(req)));
  return res;
}

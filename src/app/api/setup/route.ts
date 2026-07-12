import { NextResponse } from "next/server";
import { needsSetup, createUser, createSession, markLogin, setSetting } from "@/lib/db";
import { hashPassword, newToken } from "@/lib/password";
import { getSessionTimeoutMinutes } from "@/lib/settings-store";
import { SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE } from "@/lib/auth";

export const dynamic = "force-dynamic";

// First-run setup: create the initial admin account. Only works while the
// instance has no users; once set up, it refuses (409).
export async function POST(req: Request) {
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const username = String(body?.username ?? "").trim();
  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const password = String(body?.password ?? "");
  const companyName = String(body?.company_name ?? "").trim();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
    return NextResponse.json(
      { error: "Username must be 2–40 characters (letters, numbers, . _ -)." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  // Re-check inside the write to narrow the race window.
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  const { hash, salt } = hashPassword(password);
  let user;
  try {
    user = await createUser({
      username,
      name: name || username,
      email,
      role: "admin",
      passwordHash: hash,
      passwordSalt: salt,
      mustChange: false,
    });
  } catch {
    return NextResponse.json({ error: "Could not create the account." }, { status: 400 });
  }

  if (companyName) await setSetting("company_name", companyName.slice(0, 80));

  // Sign the new admin in immediately.
  const token = newToken();
  const expires = new Date(
    Date.now() + (await getSessionTimeoutMinutes()) * 60_000
  ).toISOString();
  await createSession(token, user.id, expires);
  await markLogin(user.id);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_MAX_AGE));
  return res;
}

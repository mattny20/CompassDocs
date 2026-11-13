import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logout, SESSION_COOKIE, cookieOptions, currentSession, secureCookie } from "@/lib/auth";
import { audit, actorFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // currentSession, not getCurrentUser (1.20.5): signing out from the Duo step is still a sign-out on the record.
  const user = (await currentSession())?.user;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await logout(token);
  if (user) await audit({ actor: actorFrom(user), action: "auth.logout" });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0, await secureCookie(req)));
  return res;
}

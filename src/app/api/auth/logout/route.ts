import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logout, SESSION_COOKIE, cookieOptions, getCurrentUser } from "@/lib/auth";
import { audit, actorFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await logout(token);
  if (user) await audit({ actor: actorFrom(user), action: "auth.logout" });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}

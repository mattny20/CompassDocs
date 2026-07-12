import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logout, SESSION_COOKIE, cookieOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  logout(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}

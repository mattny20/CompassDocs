import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getUserByUsername, setUserPassword } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";

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
  if (newPassword.length < 6) {
    return NextResponse.json({ error: "New password must be at least 6 characters." }, { status: 400 });
  }

  const record = getUserByUsername(sessionUser.username);
  if (!record || !record.password_hash || !record.password_salt) {
    return NextResponse.json({ error: "Account cannot change password here." }, { status: 400 });
  }
  if (!verifyPassword(currentPassword, record.password_hash, record.password_salt)) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }

  const { hash, salt } = hashPassword(newPassword);
  setUserPassword(record.id, hash, salt, false);
  return NextResponse.json({ ok: true });
}

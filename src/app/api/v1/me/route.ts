import { NextResponse } from "next/server";
import { v1Auth } from "@/lib/v1-auth";

export const dynamic = "force-dynamic";

/** Token introspection: who am I, and what can this token do? */
export async function GET(req: Request) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  return NextResponse.json({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    scopes: user.token_scopes,
  });
}

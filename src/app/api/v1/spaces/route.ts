import { NextResponse } from "next/server";
import { v1Auth } from "@/lib/v1-auth";
import { v1Space } from "@/lib/v1-serialize";
import { listSpaces } from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";

export const dynamic = "force-dynamic";

/** Spaces visible to the token's user. */
export async function GET(req: Request) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  const spaces = await listSpaces(await spaceScopeFor(user));
  return NextResponse.json({ items: spaces.map(v1Space) });
}

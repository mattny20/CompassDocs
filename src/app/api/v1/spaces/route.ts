import { NextResponse } from "next/server";
import { v1Auth } from "@/lib/v1-auth";
import { v1Space } from "@/lib/v1-serialize";
import { listSpaces } from "@/lib/db";
import { spaceScopeFor } from "@/lib/access";
import { findScopeFor } from "@/lib/handbook-visibility";

export const dynamic = "force-dynamic";

/** Spaces visible to the token's user; doc_count leaves out handbook-only documents they do not look after (Handbooks 1.18.0, H6). */
export async function GET(req: Request) {
  const user = await v1Auth(req, "read");
  if (user instanceof NextResponse) return user;
  const spaces = await listSpaces(await spaceScopeFor(user), await findScopeFor(user));
  return NextResponse.json({ items: spaces.map(v1Space) });
}

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listMentionableUsers } from "@/lib/db";

export const dynamic = "force-dynamic";

// Names + ids of active users, for the comment composer's @mention picker.
// Any signed-in user may look this up (same information as the people
// directory); no emails or roles are exposed here.

export async function GET() {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ users: await listMentionableUsers() });
}

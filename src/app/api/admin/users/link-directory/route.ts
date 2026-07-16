import { NextResponse } from "next/server";
import { autoLinkUsersToDirectory } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// Match unlinked accounts to directory entries by SSO id, then email.
export async function POST(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const linked = await autoLinkUsersToDirectory();
  await audit({
    actor: actorFrom(gate),
    action: "users.directory_autolink",
    details: { linked },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, linked });
}

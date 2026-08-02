import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { effectivePermissions, explain, grantsFor, admits } from "@/lib/authz";
import { isPermissionKey } from "@/lib/permissions";

export const dynamic = "force-dynamic";

/**
 * "Why can Priya publish in Engineering?" — the answer, traced back to the
 * assignments that produced it.
 *
 * Without a `permission` this returns everything the person effectively holds,
 * which is what the console shows first: an admin comparing "what I intended"
 * against "what the model actually says" is how permission bugs get found
 * before a user finds them.
 */
export async function GET(req: Request) {
  const gate = await apiGuard("admin", "role.read");
  if (gate instanceof NextResponse) return gate;

  const url = new URL(req.url);
  const userId = Number(url.searchParams.get("user_id"));
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "user_id is required." }, { status: 400 });
  }
  const spaceParam = url.searchParams.get("space_id");
  const spaceId = spaceParam === null || spaceParam === "" ? undefined : Number(spaceParam);
  if (spaceId !== undefined && !Number.isInteger(spaceId)) {
    return NextResponse.json({ error: "space_id must be a number." }, { status: 400 });
  }

  const key = url.searchParams.get("permission");
  if (key) {
    if (!isPermissionKey(key)) {
      return NextResponse.json({ error: "Unknown permission." }, { status: 400 });
    }
    const [detail, grants] = await Promise.all([explain(userId, key, spaceId), grantsFor(userId)]);
    // `granted` is what a guard would actually answer, which is not always
    // "an assignment exists": a space-scoped permission with no space named is
    // admitted when held anywhere, and the route narrows it afterwards.
    return NextResponse.json({ ...detail, granted: admits(grants, key, spaceId) });
  }

  return NextResponse.json({ permissions: await effectivePermissions(userId) });
}

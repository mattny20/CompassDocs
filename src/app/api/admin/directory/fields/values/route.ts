import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { harvestValues } from "@/lib/directory";

export const dynamic = "force-dynamic";

/**
 * "Values seen in data": every distinct raw value a field holds, with counts,
 * so the options editor can be filled from what is actually there rather than
 * from memory.
 */
export async function GET(req: Request) {
  const gate = await apiGuard("admin", "directory.field_manage");
  if (gate instanceof NextResponse) return gate;
  const key = new URL(req.url).searchParams.get("key")?.trim() ?? "";
  if (!/^[a-z0-9_]{1,40}$/.test(key)) return NextResponse.json({ error: "Bad field key." }, { status: 400 });
  return NextResponse.json({ key, values: await harvestValues(key) });
}

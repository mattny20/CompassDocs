import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listPeople, listDepartments, listFields } from "@/lib/directory";

export const dynamic = "force-dynamic";

/** The people directory — any signed-in user. Hidden entries are never returned. */
export async function GET(req: Request) {
  const gate = await apiGuard("viewer");
  if (gate instanceof NextResponse) return gate;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const department = url.searchParams.get("department")?.trim() || undefined;

  const [people, departments, fields] = await Promise.all([
    listPeople({ q, department }),
    listDepartments(),
    listFields(),
  ]);
  return NextResponse.json({ people, departments, fields });
}

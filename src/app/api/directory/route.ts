import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listPeople, listDepartments, listFields } from "@/lib/directory";
import { peopleForViewer, viewerScope } from "@/lib/directory-viewer";

export const dynamic = "force-dynamic";

/** The people directory — any signed-in user. Hidden entries are never returned. */
export async function GET(req: Request) {
  const gate = await apiGuard("viewer", "directory.read");
  if (gate instanceof NextResponse) return gate;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const department = url.searchParams.get("department")?.trim() || undefined;

  const [allPeople, departments, allFields] = await Promise.all([
    listPeople({ q, department }),
    listDepartments(),
    listFields(),
  ]);
  // Admin-only fields and restricted contact columns never leave the server.
  const scope = await viewerScope(gate, allFields);
  return NextResponse.json({ people: peopleForViewer(scope, allPeople), departments, fields: scope.fields });
}

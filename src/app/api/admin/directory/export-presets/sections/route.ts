// The sections a "Sections by" field makes of the people a preset prints,
// with their counts, in the field's own order: what the preset editor's
// Section order list previews before the admin moves anything.
//
//   GET ?field=<group_by key>&filter=<{"key","value"} JSON, optional>
//     → { sections: [{ value, label, count }] }
//
// The filter is the preset's "only people where", read by the preset's own
// rule; without one the count is everyone. The people are the ones the
// export route prints for this admin. 400 for a field the export cannot
// make sections by.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields, listPeople } from "@/lib/directory";
import { sectionSummaries } from "@/lib/directory-display";
import { sanitizePreset } from "@/lib/directory-export-config";
import { peopleForViewer, viewerScope } from "@/lib/directory-viewer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  const params = new URL(req.url).searchParams;
  const key = (params.get("field") ?? "").trim();
  // The registry and the people as the export route reads them for this admin.
  const scope = await viewerScope(gate, await listFields());
  const field = scope.fields.find((f) => f.key === key && f.group_by);
  if (!field) return NextResponse.json({ error: "Pick a field the export can make sections by." }, { status: 400 });
  let filter: unknown = null;
  const rawFilter = params.get("filter");
  if (rawFilter) {
    try {
      filter = JSON.parse(rawFilter);
    } catch {
      return NextResponse.json({ error: "Send the filter as JSON." }, { status: 400 });
    }
  }
  // The preset's rule for a filter: a real column with a value, else none.
  const only = sanitizePreset({ name: "sections", filter }, scope.fields).filter;
  const people = peopleForViewer(scope, await listPeople());
  return NextResponse.json({ sections: sectionSummaries(people, field, scope.fields, only) });
}

// Admin config for the on-screen directory: the default list columns, which
// field the grouped views open on, and how names sort. Users can still change
// these for themselves; this is what they see before they do.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getColumnVisibility,
  getGroupByDefault,
  getListColumns,
  getNameSortDefault,
  listFields,
  setColumnVisibility,
  setGroupByDefault,
  setListColumns,
  setNameSortDefault,
} from "@/lib/directory";
import { NAME_SORT_MODES, availableColumns } from "@/lib/directory-display";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  const fields = await listFields();
  return NextResponse.json({
    columns: await getListColumns(fields),
    group_by: await getGroupByDefault(fields),
    name_sort: await getNameSortDefault(),
    column_visibility: await getColumnVisibility(),
    available: availableColumns(fields),
    group_by_fields: fields.filter((f) => f.group_by).map((f) => ({ key: f.key, label: f.label })),
  });
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  let columns: string[] | undefined;
  if (body?.columns !== undefined) {
    if (!Array.isArray(body.columns)) {
      return NextResponse.json({ error: "columns must be an array of keys." }, { status: 400 });
    }
    try {
      columns = await setListColumns(body.columns.map(String));
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Could not save." }, { status: 400 });
    }
  }
  // Refused, not folded into "full": a typo must not reset the admin's default.
  if (body?.name_sort !== undefined && !(NAME_SORT_MODES as readonly string[]).includes(String(body.name_sort))) {
    return NextResponse.json({ error: "name_sort must be full, first or last." }, { status: 400 });
  }
  if (body?.group_by !== undefined) await setGroupByDefault(String(body.group_by ?? ""));
  let nameSort: string | undefined;
  if (body?.name_sort !== undefined) nameSort = await setNameSortDefault(String(body.name_sort));
  if (body?.column_visibility !== undefined) await setColumnVisibility(body.column_visibility);
  await audit({
    actor: actorFrom(gate),
    action: "settings.directory_list",
    details: { columns, group_by: body?.group_by, name_sort: nameSort, column_visibility: body?.column_visibility },
    ip: ipFrom(req),
  });
  const fields = await listFields();
  return NextResponse.json({
    ok: true,
    columns: await getListColumns(fields),
    group_by: await getGroupByDefault(fields),
    name_sort: await getNameSortDefault(),
    column_visibility: await getColumnVisibility(),
  });
}

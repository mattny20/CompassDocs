// Admin config for the on-screen directory: the default list columns, and
// which field the grouped views open on. Users can still change columns for
// themselves; this is what they see before they do.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getGroupByDefault, getListColumns, listFields, setGroupByDefault, setListColumns } from "@/lib/directory";
import { availableColumns } from "@/lib/directory-display";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  const fields = await listFields();
  return NextResponse.json({
    columns: await getListColumns(fields),
    group_by: await getGroupByDefault(fields),
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
  if (body?.group_by !== undefined) await setGroupByDefault(String(body.group_by ?? ""));
  await audit({
    actor: actorFrom(gate),
    action: "settings.directory_list",
    details: { columns, group_by: body?.group_by },
    ip: ipFrom(req),
  });
  const fields = await listFields();
  return NextResponse.json({ ok: true, columns: await getListColumns(fields), group_by: await getGroupByDefault(fields) });
}

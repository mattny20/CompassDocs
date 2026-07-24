// Admin config for the quick-print directory: which columns it shows, in
// which order. GET returns the current selection plus every available
// column (built-ins and custom fields); PUT replaces the selection.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setSetting } from "@/lib/db";
import { getPrintColumns, listFields, PRINT_BUILTINS } from "@/lib/directory";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  const fields = await listFields();
  return NextResponse.json({
    columns: await getPrintColumns(),
    available: [
      ...PRINT_BUILTINS,
      ...fields.map((f) => ({ key: f.key, label: f.label })),
    ],
  });
}

export async function PUT(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!Array.isArray(body?.columns)) {
    return NextResponse.json({ error: "columns must be an array of keys." }, { status: 400 });
  }
  const valid = new Set([
    ...PRINT_BUILTINS.map((b) => b.key),
    ...(await listFields()).map((f) => f.key),
  ]);
  const columns = body.columns.map(String).filter((k: string, i: number, a: string[]) => valid.has(k) && a.indexOf(k) === i);
  if (!columns.length) {
    return NextResponse.json({ error: "Pick at least one column." }, { status: 400 });
  }
  await setSetting("directory_print_columns", JSON.stringify(columns));
  await audit({
    actor: actorFrom(gate),
    action: "settings.directory_print",
    details: { columns },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, columns });
}

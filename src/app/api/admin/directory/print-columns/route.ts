// Compatibility for the pre-1.2 "print columns" contract: reads and writes the
// default export preset's columns. New callers use /export-presets.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields } from "@/lib/directory";
import { availableColumns } from "@/lib/directory-display";
import { listExportPresets, saveExportPresets } from "@/lib/directory-export-config";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  const fields = await listFields();
  const presets = await listExportPresets(fields);
  const def = presets.find((p) => p.is_default) ?? presets[0];
  return NextResponse.json({ columns: def.columns, available: availableColumns(fields) });
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
  if (!Array.isArray(body?.columns) || !body.columns.length) {
    return NextResponse.json({ error: "columns must be a non-empty array of keys." }, { status: 400 });
  }
  const fields = await listFields();
  const presets = await listExportPresets(fields);
  const next = presets.map((p) => (p.is_default ? { ...p, columns: body.columns.map(String) } : p));
  const saved = await saveExportPresets(next, fields);
  const def = saved.find((p) => p.is_default) ?? saved[0];
  await audit({ actor: actorFrom(gate), action: "settings.directory_print", details: { columns: def.columns }, ip: ipFrom(req) });
  return NextResponse.json({ ok: true, columns: def.columns });
}

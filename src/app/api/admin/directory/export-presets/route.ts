// Export presets: the layouts a PDF/CSV export starts from. GET returns them
// with everything the editor needs to offer (columns, group-by fields); PUT
// replaces the whole set.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields } from "@/lib/directory";
import { availableColumns } from "@/lib/directory-display";
import {
  DENSITIES,
  ORIENTATIONS,
  PAPER_SIZES,
  listExportPresets,
  saveExportPresets,
} from "@/lib/directory-export-config";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  const fields = await listFields();
  return NextResponse.json({
    presets: await listExportPresets(fields),
    available: availableColumns(fields),
    group_by_fields: fields.filter((f) => f.group_by).map((f) => ({ key: f.key, label: f.label })),
    paper_sizes: PAPER_SIZES,
    orientations: ORIENTATIONS,
    densities: DENSITIES,
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
  try {
    const presets = await saveExportPresets(body?.presets);
    await audit({
      actor: actorFrom(gate),
      action: "settings.directory_export",
      details: { presets: presets.map((p) => p.name), default: presets.find((p) => p.is_default)?.name },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, presets });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not save." }, { status: 400 });
  }
}

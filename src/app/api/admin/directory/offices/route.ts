// Office profiles: the fields every office describes itself with, and each
// office's values. Same permission as the export presets — both shape what
// comes out on paper.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getOfficeConfig, saveOfficeConfig } from "@/lib/directory-offices-store";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getOfficeConfig());
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
  let config;
  try {
    config = await saveOfficeConfig(body);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not save the offices." }, { status: 400 });
  }
  await audit({
    actor: actorFrom(gate),
    action: "directory.offices_updated",
    details: { fields: config.fields.length, offices: config.profiles.length },
    ip: ipFrom(req),
  });
  return NextResponse.json(config);
}

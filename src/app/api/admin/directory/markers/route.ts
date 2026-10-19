// Export markers: the symbols an export prints in front of a name for people
// who match a field value, with the key in the footer. GET returns them with
// the fields a marker may read; PUT replaces the whole set and refuses,
// naming the first problem, rather than saving a marker short of what was
// typed (a symbol the PDF cannot print would come out as a box on paper).

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { listFields } from "@/lib/directory";
import { listMarkers, markerFields, saveMarkers } from "@/lib/directory-markers";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "directory.print_columns_manage");
  if (gate instanceof NextResponse) return gate;
  const fields = await listFields();
  return NextResponse.json({ markers: await listMarkers(fields), fields: markerFields(fields) });
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
    const markers = await saveMarkers(body?.markers);
    await audit({
      actor: actorFrom(gate),
      action: "settings.directory_markers",
      details: { markers: markers.map((m) => `${m.symbol} ${m.label}`) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, markers });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Could not save." }, { status: 400 });
  }
}

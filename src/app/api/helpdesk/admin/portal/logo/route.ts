// POST   /api/helpdesk/admin/portal/logo  multipart { file } → { settings }
// DELETE /api/helpdesk/admin/portal/logo                   → { settings }
//
// Helpdesk 1.19.1, Desk settings → Customer portal: the portal's logo, in
// the existing uploads store (lib/uploads). PNG, JPEG, GIF or WebP,
// identified by its bytes (never SVG), up to 1 MB. Desk capability
// settings.manage. Audited as helpdesk.portal.updated { changed: ["brand_logo"] }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { deleteUpload, saveUpload, sniffImage } from "@/lib/uploads";
import { getPortalSettings, savePortalSettings } from "@/lib/helpdesk/portal";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024;

async function record(req: Request, gate: SessionUser, removed: boolean) {
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.portal.updated",
    targetType: "helpdesk_portal",
    targetLabel: "Customer portal",
    details: { changed: ["brand_logo"], removed },
    ip: ipFrom(req),
  });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return NextResponse.json({ error: "The request must state its size." }, { status: 411 });
  if (Number(declared) > MAX_BYTES + 256 * 1024) return NextResponse.json({ error: "Logos are limited to 1 MB." }, { status: 413 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest("Expected a file upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return badRequest("No file provided.");
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Logos are limited to 1 MB." }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const img = sniffImage(buf);
  if (!img) return NextResponse.json({ error: "Use a PNG, JPEG, GIF or WebP image." }, { status: 415 });
  const stored = await saveUpload(buf, img.ext);
  const before = await getPortalSettings();
  const { settings } = await savePortalSettings({ ...before, brand_logo: stored });
  if (before.brand_logo && before.brand_logo !== stored) await deleteUpload(before.brand_logo);
  await record(req, gate, false);
  return NextResponse.json({ settings });
}

export async function DELETE(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const before = await getPortalSettings();
  if (!before.brand_logo) return NextResponse.json({ settings: before });
  const { settings } = await savePortalSettings({ ...before, brand_logo: "" });
  await deleteUpload(before.brand_logo);
  await record(req, gate, true);
  return NextResponse.json({ settings });
}

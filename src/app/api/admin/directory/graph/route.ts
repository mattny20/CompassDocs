import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getDirectoryGraphConfig,
  updateDirectoryGraphConfig,
  getDirectorySyncStatus,
} from "@/lib/directory-config";
import { featureEnabled, eePresent } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

// The client secret is write-only: GET only reports whether one is stored.
async function view() {
  const [cfg, status, enabled] = await Promise.all([
    getDirectoryGraphConfig(),
    getDirectorySyncStatus(),
    featureEnabled("directory_sync"),
  ]);
  return {
    enabled, // bundled AND licensed
    bundled: eePresent(),
    tenant: cfg.tenant,
    client_id: cfg.clientId,
    has_secret: Boolean(cfg.clientSecret),
    group: cfg.group,
    include_guests: cfg.includeGuests,
    require_title: cfg.requireTitle,
    require_phone: cfg.requirePhone,
    photos: cfg.photos,
    last_sync: status,
  };
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  await updateDirectoryGraphConfig({
    ...(body?.tenant !== undefined ? { tenant: String(body.tenant) } : {}),
    ...(body?.client_id !== undefined ? { clientId: String(body.client_id) } : {}),
    // Only overwrite the stored secret when a new value is actually provided.
    ...(typeof body?.client_secret === "string" && body.client_secret !== ""
      ? { clientSecret: body.client_secret }
      : {}),
    ...(body?.clear_secret === true ? { clientSecret: "" } : {}),
    ...(body?.group !== undefined ? { group: String(body.group) } : {}),
    ...(body?.include_guests !== undefined ? { includeGuests: Boolean(body.include_guests) } : {}),
    ...(body?.require_title !== undefined ? { requireTitle: Boolean(body.require_title) } : {}),
    ...(body?.require_phone !== undefined ? { requirePhone: Boolean(body.require_phone) } : {}),
    ...(body?.photos !== undefined ? { photos: Boolean(body.photos) } : {}),
  });

  await audit({
    actor: actorFrom(gate),
    action: "settings.directory_graph",
    details: { secret_changed: Boolean(body?.client_secret) || body?.clear_secret === true },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, state: await view() });
}

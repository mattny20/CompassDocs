import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import {
  getDirectoryGoogleConfig,
  updateDirectoryGoogleConfig,
  getGoogleSyncStatus,
  googleDirectoryConfigured,
  serviceAccountProblem,
  serviceAccountClientId,
  GOOGLE_DIRECTORY_SCOPES,
} from "@/lib/directory-google-config";
import { featureEnabled, eePresent } from "@/lib/ee";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Google Workspace directory-sync configuration. A sibling of ../graph rather
// than a generalisation of it — see lib/directory-google-config for why.
//
// The service-account key is write-only: GET reports whether one is stored and
// echoes back only its client_id, which is not secret and is the value an admin
// has to paste into the domain-wide delegation screen.
async function view() {
  const [cfg, status, enabled] = await Promise.all([
    getDirectoryGoogleConfig(),
    getGoogleSyncStatus(),
    featureEnabled("directory_sync"),
  ]);
  return {
    enabled, // bundled AND licensed
    bundled: eePresent(),
    has_service_account: Boolean(cfg.serviceAccount),
    service_account_client_id: serviceAccountClientId(cfg.serviceAccount),
    admin_email: cfg.adminEmail,
    customer_id: cfg.customerId,
    group: cfg.group,
    include_suspended: cfg.includeSuspended,
    photos: cfg.photos,
    configured: googleDirectoryConfigured(cfg),
    scopes: GOOGLE_DIRECTORY_SCOPES,
    last_sync: status,
  };
}

export async function GET() {
  const gate = await apiGuard("admin", "directory.sync_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "directory.sync_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Validate the key before storing it. A malformed paste otherwise surfaces as
  // an authentication failure at the next sync, which points at the wrong
  // thing entirely.
  if (typeof body?.service_account === "string" && body.service_account !== "") {
    const problem = serviceAccountProblem(body.service_account);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  await updateDirectoryGoogleConfig({
    // Only overwrite the stored key when a new value is actually provided —
    // the panel sends "" to mean "leave it alone", not "clear it".
    ...(typeof body?.service_account === "string" && body.service_account !== ""
      ? { serviceAccount: body.service_account }
      : {}),
    ...(body?.admin_email !== undefined ? { adminEmail: String(body.admin_email) } : {}),
    ...(body?.customer_id !== undefined ? { customerId: String(body.customer_id) } : {}),
    ...(body?.group !== undefined ? { group: String(body.group) } : {}),
    ...(body?.include_suspended !== undefined
      ? { includeSuspended: Boolean(body.include_suspended) }
      : {}),
    ...(body?.photos !== undefined ? { photos: Boolean(body.photos) } : {}),
  });

  await audit({
    actor: actorFrom(user),
    action: "settings.directory_google",
    details: {
      key_replaced: typeof body?.service_account === "string" && body.service_account !== "",
    },
    ip: ipFrom(req),
  });
  return NextResponse.json(await view());
}

// Clearing the connection. Separate from PATCH because "" means "unchanged"
// there, so there would otherwise be no way to express "remove the key".
export async function DELETE(req: Request) {
  const gate = await apiGuard("admin", "directory.sync_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  await updateDirectoryGoogleConfig({ serviceAccount: "", adminEmail: "" });
  await audit({
    actor: actorFrom(user),
    action: "settings.directory_google_cleared",
    ip: ipFrom(req),
  });
  return NextResponse.json(await view());
}

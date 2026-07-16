import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setSetting, getDatabaseStats } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { licenseState, licenseSource, parseLicense } from "@/lib/license";
import type { EntitlementFeature } from "@/lib/license";
import { ee, eePresent } from "@/lib/ee";

export const dynamic = "force-dynamic";

// All entitlements the product knows about, with friendly labels for the UI.
const ALL_FEATURES: { key: EntitlementFeature; label: string }[] = [
  { key: "sso", label: "Single sign-on (SSO)" },
  { key: "scim", label: "SCIM provisioning" },
  { key: "audit_export", label: "Audit-log export" },
  { key: "priority_support", label: "Priority support" },
  { key: "directory_sync", label: "Microsoft 365 directory sync" },
  { key: "policy_ack", label: "Policy acknowledgements" },
];

// Build a client-safe view. The raw license token is never echoed back; its
// (non-secret) decoded claims are fine to display.
async function state() {
  const [s, source, stats] = await Promise.all([
    licenseState(),
    licenseSource(),
    getDatabaseStats(),
  ]);
  const bundled = ee().features;
  const licensed =
    s.status === "active" || s.status === "grace" ? s.license.features : [];

  const license =
    "license" in s
      ? {
          customer: s.license.customer,
          plan: s.license.plan,
          seats: s.license.seats,
          issued: s.license.issued,
          expires: s.license.expires,
        }
      : null;

  return {
    edition: eePresent() ? "enterprise" : "community",
    source, // settings | env | none
    status: s.status, // none | invalid | active | grace | expired
    reason: s.status === "invalid" ? s.reason : undefined,
    daysLeft: s.status === "active" || s.status === "grace" ? s.daysLeft : undefined,
    license,
    seatsUsed: stats.users,
    features: ALL_FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      bundled: bundled.includes(f.key), // present in this build
      licensed: licensed.includes(f.key), // granted by the license
      active: bundled.includes(f.key) && licensed.includes(f.key),
    })),
  };
}

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await state());
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

  if (body?.clear === true) {
    await setSetting("license_key", "");
    await audit({ actor: actorFrom(gate), action: "license.removed", ip: ipFrom(req) });
    return NextResponse.json({ ok: true, state: await state() });
  }

  const key = typeof body?.license_key === "string" ? body.license_key.trim() : "";
  if (key) {
    // Reject an invalid/tampered key up front rather than storing garbage.
    const { license, error } = parseLicense(key);
    if (error || !license) {
      return NextResponse.json({ error: error || "Invalid license." }, { status: 400 });
    }
    await setSetting("license_key", key);
    await audit({
      actor: actorFrom(gate),
      action: "license.set",
      targetLabel: license.customer,
      details: { plan: license.plan, expires: license.expires },
      ip: ipFrom(req),
    });
  }

  return NextResponse.json({ ok: true, state: await state() });
}

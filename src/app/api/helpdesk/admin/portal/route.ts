// GET /api/helpdesk/admin/portal → { settings, types, teams, custom_domain, path }
// PUT /api/helpdesk/admin/portal  PortalSettings (brand_logo excepted: the
//     logo route sets it) → { settings, types }
//
// Helpdesk 1.19.1, Desk settings → Customer portal (agent V6): on or off,
// which request types outside customers can raise and the team each goes
// to, who can use it (anyone with an email, or approved domains), the
// brand, and protection (per-address limits, blocked words and domains).
// A request type that needs the directory (lib/helpdesk/portal
// portalBlockers) can't be exposed: 400 naming why. Desk capability
// settings.manage. Audited as helpdesk.portal.updated with { changed }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { hq } from "@/lib/helpdesk/db-core";
import { getAppSettings } from "@/lib/settings-store";
import {
  PORTAL_BLOCKER_TEXT,
  PORTAL_PATH,
  cleanPortalSettings,
  getPortalSettings,
  portalTypeOptions,
  savePortalSettings,
} from "@/lib/helpdesk/portal";

export const dynamic = "force-dynamic";

async function extras() {
  const [teams, app] = await Promise.all([
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name, id"),
    getAppSettings().catch(() => ({ custom_domain: "" })),
  ]);
  return { teams, custom_domain: app.custom_domain || "", path: PORTAL_PATH };
}

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const settings = await getPortalSettings();
  return NextResponse.json({ settings, types: await portalTypeOptions(settings), ...(await extras()) });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  const before = await getPortalSettings();
  // The logo is the logo route's: whatever the body says, keep the stored one.
  const next = cleanPortalSettings({ ...b, brand_logo: before.brand_logo });
  const options = await portalTypeOptions(before);
  for (const t of next.types) {
    const o = options.find((x) => x.id === t.id);
    if (!o) return badRequest("One of the request types no longer exists. Reload the page.");
    if (o.blockers.length) return badRequest(`“${o.title}” can't be offered to outside customers: ${PORTAL_BLOCKER_TEXT[o.blockers[0]].toLowerCase()}`);
  }
  const teamIds = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams")).map((r) => r.id));
  if (next.types.some((t) => t.team_id !== null && !teamIds.has(t.team_id))) return badRequest("One of the teams no longer exists. Reload the page.");
  if (next.access === "domains" && next.domains.length === 0) return badRequest("Add at least one approved domain, or let anyone with an email use the portal.");
  if (next.enabled && next.types.length === 0) return badRequest("Choose at least one thing customers can ask for before turning the portal on.");
  const { settings, changed } = await savePortalSettings(next);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.portal.updated",
      targetType: "helpdesk_portal",
      targetLabel: "Customer portal",
      details: {
        changed,
        ...(changed.includes("enabled") ? { enabled: settings.enabled } : {}),
        ...(changed.includes("access") ? { access: settings.access } : {}),
        ...(changed.includes("types") ? { types: settings.types.map((t) => t.id) } : {}),
      },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ settings, types: await portalTypeOptions(settings), ...(await extras()) });
}

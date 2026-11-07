// GET /api/helpdesk/admin/portal/help-centre
//     → { settings, spaces, categories, stats, portal_on }
// PUT /api/helpdesk/admin/portal/help-centre  HelpCentreSettings
//     → the same shape, after saving
// POST /api/helpdesk/admin/portal/help-centre  { preview: HelpCentreSettings }
//     → { categories } for a selection not saved yet (nothing stored)
//
// Helpdesk 1.19.4 (C3), Desk settings → Customer portal → Help centre: on
// or off, what's public (chosen spaces and/or documents tagged public),
// the categories' order and which are switched off, search engine
// indexing, and the last 30 days' numbers. What is actually public is
// lib/helpdesk/help-centre publicHelpArticles; this route only stores the
// choices. Desk capability settings.manage. Audited as
// helpdesk.portal.help_centre_updated with { changed } (and the new value
// of enabled, the space ids, tagged and indexing when they changed).

import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/types";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { getPortalSettings } from "@/lib/helpdesk/portal";
import {
  cleanHelpCentreSettings,
  getHelpCentreSettings,
  helpCentreAdminCategories,
  helpCentreSpaceOptions,
  helpCentreStats,
  saveHelpCentreSettings,
  type HelpCentreSettings,
} from "@/lib/helpdesk/help-centre";

export const dynamic = "force-dynamic";

/**
 * The page's data. `spaces` names every space that is not private, and of
 * the private ones only those already chosen or that this person can open
 * (helpCentreSpaceOptions): settings.manage is a desk capability, never a
 * way to learn which private spaces exist.
 */
async function view(user: SessionUser, settings: HelpCentreSettings) {
  const portal = await getPortalSettings();
  const [spaces, categories, stats] = await Promise.all([helpCentreSpaceOptions(user, settings.spaces), helpCentreAdminCategories(settings, portal), helpCentreStats()]);
  return { settings, spaces, categories, stats, portal_on: portal.enabled };
}

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view(gate, await getHelpCentreSettings()));
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b || typeof b.preview !== "object") return badRequest("Send the selection to preview.");
  return NextResponse.json({ categories: await helpCentreAdminCategories(cleanHelpCentreSettings(b.preview)) });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  const next = cleanHelpCentreSettings(b);
  const stored = await getHelpCentreSettings();
  // A private space nobody showed this person reads as one that does not exist.
  const spaces = await helpCentreSpaceOptions(gate, stored.spaces);
  const known = new Map(spaces.map((s) => [s.id, s]));
  if (next.spaces.some((id) => !known.has(id))) return badRequest("One of the spaces no longer exists. Reload the page.");
  const priv = next.spaces.map((id) => known.get(id)!).find((s) => s.private);
  if (priv) return badRequest(`“${priv.name}” is a private space. Private spaces are never public: remove it from the help centre.`);
  if (next.enabled && !next.tagged && !(next.from_spaces && next.spaces.length)) {
    return badRequest("Choose at least one space, or documents tagged public, before showing the help centre.");
  }
  const { settings, changed } = await saveHelpCentreSettings(next);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.portal.help_centre_updated",
      targetType: "helpdesk_portal",
      targetLabel: "Customer portal help centre",
      details: {
        changed,
        ...(changed.includes("enabled") ? { enabled: settings.enabled } : {}),
        ...(changed.includes("spaces") || changed.includes("from_spaces") ? { from_spaces: settings.from_spaces, spaces: settings.spaces } : {}),
        ...(changed.includes("tagged") ? { tagged: settings.tagged } : {}),
        ...(changed.includes("indexing") ? { indexing: settings.indexing } : {}),
        ...(changed.includes("hidden") ? { hidden: settings.hidden } : {}),
      },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(await view(gate, settings));
}

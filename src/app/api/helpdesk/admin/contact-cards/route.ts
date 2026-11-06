// GET /api/helpdesk/admin/contact-cards → { settings, options }
// PUT /api/helpdesk/admin/contact-cards  HdContactCardSettings (any top-level keys) → { settings }
//
// Helpdesk 1.19.0, Desk settings → Contact cards: which directory field
// fills each card slot, Teams/Webex/Slack, extra fields, VIPs, office time
// zones, and what requesters and agents each see. Desk capability
// settings.manage. Audited as helpdesk.settings.updated with
// { section: "contact_cards", changed }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { hq } from "@/lib/helpdesk/db-core";
import { listDepartments, listFields } from "@/lib/directory";
import { listMarkers } from "@/lib/directory-markers";
import { getOfficeConfig } from "@/lib/directory-offices-store";
import { officeBlock, officeKeyOf, officeProfileFor } from "@/lib/directory-offices";
import { getContactCardSettings, saveContactCardSettings, vipListLabels } from "@/lib/helpdesk/contact-cards";

export const dynamic = "force-dynamic";

/** The built-in contact columns, which are not registry fields. */
const BUILTIN_COLUMNS = [
  { key: "email", label: "Email", kind: "text", display: "field" },
  { key: "phone", label: "Phone", kind: "text", display: "phone" },
  { key: "mobile", label: "Mobile", kind: "text", display: "phone" },
] as const;

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const [settings, fields, departments, offices, groups, users, colVis] = await Promise.all([
    getContactCardSettings(),
    listFields(),
    listDepartments(),
    getOfficeConfig(),
    hq<{ id: number; name: string }>("SELECT id, name FROM groups ORDER BY name LIMIT 2000"),
    hq<{ id: number; name: string; username: string; email: string }>(
      "SELECT id, name, username, email FROM users WHERE status = 'active' ORDER BY name, username LIMIT 5000"
    ),
    import("@/lib/directory").then((m) => m.getColumnVisibility()),
  ]);
  const markers = await listMarkers(fields);
  const officeField = fields.find((f) => f.key === "office");
  const rawOffices = await hq<{ office: string }>(
    "SELECT DISTINCT office FROM directory_people WHERE hidden = 0 AND office <> '' ORDER BY office LIMIT 500"
  );
  const officeMap = new Map<string, string>();
  for (const { office } of rawOffices) {
    const key = officeKeyOf(office, officeField);
    if (!key || officeMap.has(key.toLowerCase())) continue;
    const profile = officeProfileFor(offices, key);
    officeMap.set(key.toLowerCase(), profile ? officeBlock(profile, offices.fields, officeField).name : key);
  }
  for (const p of offices.profiles) {
    if (!officeMap.has(p.office.toLowerCase())) officeMap.set(p.office.toLowerCase(), officeBlock(p, offices.fields, officeField).name);
  }
  return NextResponse.json({
    settings,
    options: {
      fields: [
        ...BUILTIN_COLUMNS.map((c) => ({ ...c, visibility: colVis[c.key] === "admins" ? "admins" : "everyone", builtin: true })),
        ...fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, display: f.display, visibility: f.visibility, builtin: !!f.builtin })),
      ],
      markers: markers.map((m) => ({ id: m.id, label: m.label, symbol: m.symbol })),
      groups,
      departments,
      offices: [...officeMap].map(([key, name]) => ({ key, name })),
      users: users.map((u) => ({ id: u.id, name: u.name || u.username, email: u.email })),
      labels: await vipListLabels(settings),
    },
  });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 512 * 1024);
  if (!body) return badRequest("Send the contact card settings as JSON.");
  const { settings, changed } = await saveContactCardSettings(body);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.settings.updated",
      targetType: "helpdesk_settings",
      targetLabel: "Helpdesk contact cards",
      details: { section: "contact_cards", changed },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ settings });
}

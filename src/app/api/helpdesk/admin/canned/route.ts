// GET  /api/helpdesk/admin/canned   the library: every response the caller may see, each with can_edit and its uses in 30 days, plus share_options and placeholders
// POST /api/helpdesk/admin/canned   { title, body, folder?, share: "me" | "workspace" | "team:<id>" }
//   (30 a minute per person; 200 personal ones per owner, 2,000 shared ones in all)
// With macros.manage_all, GET also lists inactive_owners: deactivated people
// who still own personal responses, with a count only (./inactive deletes them).
// Helpdesk 1.19.2 (agent W4). Desk settings → Canned responses. Who writes
// which sharing is agent J's macro capabilities (lib/helpdesk/canned):
// only me macros.manage_personal, a team macros.manage_team in that team
// (its team leads), the workspace macros.manage_all. Audited as
// helpdesk.canned.created.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { agentTeamIds, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import {
  CANNED_MANAGE_CAPS,
  CANNED_PLACEHOLDERS,
  CannedError,
  cannedScope,
  createCanned,
  inactiveOwners,
  listCanned,
  mayManageCanned,
  shareOptionsFor,
  validateCannedInput,
  type CannedInput,
} from "@/lib/helpdesk/canned";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  const all = await hdCan(gate, "macros.manage_all");
  const list = await listCanned(all ? "all" : await agentTeamIds(gate), gate.id);
  const canned = [];
  for (const c of list) canned.push({ ...c, can_edit: await mayManageCanned(gate, c) });
  return NextResponse.json(
    { canned, share_options: await shareOptionsFor(gate), placeholders: CANNED_PLACEHOLDERS, ...(all ? { inactive_owners: await inactiveOwners() } : {}) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-canned-new:${gate.id}`, 30, 60_000)) return tooMany();
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the canned response as JSON." }, { status: 400 });
  try {
    const input = (await validateCannedInput(body, gate.id)) as CannedInput;
    if (!(await mayManageCanned(gate, input))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
    const c = await createCanned(input, gate.id);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.canned.created",
      targetType: "helpdesk_canned",
      targetId: c.id,
      targetLabel: c.title,
      details: { scope: cannedScope(c), team_id: c.team_id, folder: c.folder || null },
      ip: ipFrom(req),
    });
    return NextResponse.json({ canned: { ...c, can_edit: true } }, { status: 201 });
  } catch (e) {
    if (e instanceof CannedError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

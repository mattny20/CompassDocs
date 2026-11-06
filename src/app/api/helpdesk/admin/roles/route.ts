// GET  /api/helpdesk/admin/roles  → { matrix, defaults, capabilities, roles, me, locks }
// PUT  /api/helpdesk/admin/roles  { matrix: { newbie?: cap[], agent?: cap[], team_lead?: cap[], manager?: cap[] } } → { matrix }
// POST /api/helpdesk/admin/roles  (Reset to defaults: the columns the caller may change) → { matrix }
// Helpdesk 1.19.0 desk roles (agent J). roles.manage. The invariants
// (roles-shared checkMatrix) are enforced here whatever the page sent:
// Admin always has everything (and replies directly, never after review);
// nobody grants or removes a capability they don't hold (direct replies
// cover reply after review) or changes a role at or above their own;
// roles.manage and agents.assign_roles stay with Managers; reply after
// review and direct replies are exclusive.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { getRoleMatrix, hdCapGate, hdCapsFor, saveRoleMatrix } from "@/lib/helpdesk/roles";
import {
  HD_CAPABILITIES,
  HD_CAP_KEYS,
  HD_DEFAULT_MATRIX,
  HD_ROLES,
  cellLockedReason,
  checkMatrix,
  columnLockedReason,
  type HdRoleMatrix,
} from "@/lib/helpdesk/roles-shared";

export const dynamic = "force-dynamic";

function diff(before: HdRoleMatrix, after: HdRoleMatrix) {
  const out: Record<string, { added: string[]; removed: string[] }> = {};
  for (const r of HD_ROLES) {
    const added = after[r].filter((c) => !before[r].includes(c));
    const removed = before[r].filter((c) => !after[r].includes(c));
    if (added.length || removed.length) out[r] = { added, removed };
  }
  return out;
}

export async function GET() {
  const gate = await hdCapGate("roles.manage");
  if (gate instanceof NextResponse) return gate;
  const [matrix, me] = await Promise.all([getRoleMatrix(), hdCapsFor(gate)]);
  const locks: Record<string, Record<string, string | null>> = {};
  for (const r of HD_ROLES) {
    locks[r] = {};
    for (const c of HD_CAP_KEYS) locks[r][c] = cellLockedReason(r, c, me.role, me.caps);
  }
  return NextResponse.json({
    matrix,
    defaults: HD_DEFAULT_MATRIX,
    capabilities: HD_CAP_KEYS.map((k) => ({ key: k, ...HD_CAPABILITIES[k] })),
    roles: HD_ROLES,
    me,
    locks,
  });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("roles.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 32 * 1024);
  if (!b || !b.matrix) return NextResponse.json({ error: "Send { matrix }." }, { status: 400 });
  const [current, me] = await Promise.all([getRoleMatrix(), hdCapsFor(gate)]);
  const checked = checkMatrix(b.matrix, current, { role: me.role, caps: me.caps });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  if (!checked.changed.length) return NextResponse.json({ matrix: current });
  const saved = await saveRoleMatrix(checked.matrix);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.roles.updated",
    targetType: "helpdesk_roles",
    targetId: "matrix",
    targetLabel: "Desk roles",
    details: { changes: diff(current, saved) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ matrix: saved });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("roles.manage");
  if (gate instanceof NextResponse) return gate;
  const [current, me] = await Promise.all([getRoleMatrix(), hdCapsFor(gate)]);
  // Reset only the columns the caller may change, and only through the same checks.
  const proposed: Partial<HdRoleMatrix> = {};
  for (const r of HD_ROLES) if (!columnLockedReason(r, me.role)) proposed[r] = HD_DEFAULT_MATRIX[r];
  const checked = checkMatrix(proposed, current, { role: me.role, caps: me.caps });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const saved = checked.changed.length ? await saveRoleMatrix(checked.matrix) : current;
  if (checked.changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.roles.reset",
      targetType: "helpdesk_roles",
      targetId: "matrix",
      targetLabel: "Desk roles",
      details: { roles: checked.changed, changes: diff(current, saved) },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ matrix: saved });
}

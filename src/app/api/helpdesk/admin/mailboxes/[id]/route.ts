// PATCH  /api/helpdesk/admin/mailboxes/[id]   { address?, name?, team_id?, send_from?, is_default?: true } → { mailbox }
// DELETE /api/helpdesk/admin/mailboxes/[id]   → { ok, moved, moved_to: { id, address } | null }. Its tickets move to the
//          default address (when the default itself goes, the next one becomes the default first).
// Helpdesk 1.20.2 (lib/helpdesk/mailboxes). channels.manage (settings.manage covers it), as the
// Email settings page. Audited (helpdesk.mailbox.updated with the changed fields from → to,
// helpdesk.mailbox.deleted with the tickets moved).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { HdMailboxError, deleteMailbox, updateMailbox } from "@/lib/helpdesk/mailboxes";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  try {
    const mailbox = await updateMailbox(id, b, { actor: actorFrom(gate), ip: ipFrom(req) });
    if (!mailbox) return notFound();
    return NextResponse.json({ mailbox });
  } catch (e) {
    if (e instanceof HdMailboxError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const r = await deleteMailbox(id, { actor: actorFrom(gate), ip: ipFrom(req) });
  if (!r) return notFound();
  return NextResponse.json({ ok: true, moved: r.moved, moved_to: r.moved_to ? { id: r.moved_to.id, address: r.moved_to.address } : null });
}

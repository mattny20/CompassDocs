// PATCH  /api/helpdesk/admin/mailboxes/[id]   { address?, name?, team_id?, send_address_id?, send_from?, is_default?: true } → { mailbox }
//          1.20.5: `send_address_id` picks the send-from address replies go out From (an id from
//          /api/helpdesk/admin/send-addresses, or null = the workspace address). The older `send_from` is still
//          taken: true = the address itself (added to the send-from list when missing), false = the workspace
//          address; `send_address_id` wins when both are sent. The mailbox still answers `send_from` (true
//          exactly when it sends from itself) and `send_from_error`, and now `send_address_id`, `send_address`
//          and `send_address_name` as well.
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

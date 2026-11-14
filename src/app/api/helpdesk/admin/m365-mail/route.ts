// GET    /api/helpdesk/admin/m365-mail  → M365MailView (lib/helpdesk/m365-mail-shared): the connection (never the
//          secret), the connected mailboxes with their status, which help address lives on which, the last access check.
// PUT    /api/helpdesk/admin/m365-mail  { tenant, client_id, secret } → { view, created, verified, tenant_wide }
//          The manual form: an app registration the admin made. Signed in with before anything is saved: 409 with
//          Microsoft's reason when the sign-in is refused or the mailboxes here belong to another tenant, 502 when
//          Microsoft could not be reached. An empty secret keeps the saved one for the same app. `tenant_wide`: the
//          Graph mail permissions the app's token carries (any of them reaches every mailbox), recorded with the save.
// PATCH  /api/helpdesk/admin/m365-mail  { after?: "read" | "move", folder?, notifications?, poll_minutes?, notify_here?: true } → { view, changed }
//          `notify_here`: Microsoft posts notifications to the address this request came in on (it must be public https).
// DELETE /api/helpdesk/admin/m365-mail  → { view }. Forgets the app registration; mailboxes stay listed, idle.
// Helpdesk 1.20.7 (lib/helpdesk/m365/mail): the Microsoft 365 mailbox connection on Desk settings → Email. Audited.
// Reading the view and the options (PATCH) take the page's own capability, channels.manage (settings.manage covers
// it). Saving or removing the connection (PUT, DELETE) decides which Microsoft 365 app the desk signs in as, so it
// takes settings.manage, as connecting and disconnecting a mailbox do. GET writes nothing.

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { m365TestBase } from "@/lib/helpdesk/m365/graph";
import { M365MailError, m365MailView, removeM365Connection, saveM365Connection, saveM365Settings } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate, hdCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];

async function view(req: Request) {
  void req;
  const v = await m365MailView();
  // The rig's fake Microsoft, when the test seam is set (never on a real install).
  const seam = m365TestBase();
  return seam ? { ...v, test_base: seam } : v;
}

const refuse = (e: unknown) => {
  if (e instanceof M365MailError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
  throw e;
};

export async function GET(req: Request) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view(req));
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the app registration as JSON.");
  try {
    const r = await saveM365Connection(b, { actor: actorFrom(gate), ip: ipFrom(req) }, { setup: "manual", origin: await publicOrigin(req) });
    return NextResponse.json({ view: await view(req), created: r.created, verified: r.verified, tenant_wide: r.tenant_wide });
  } catch (e) {
    return refuse(e);
  }
}

export async function PATCH(req: Request) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 16 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  try {
    // `notify_here: true`: Microsoft should post notifications to the address this request came in on (never a typed one).
    const { notify_here, notify_origin: _typed, ...rest } = b as Record<string, unknown>;
    void _typed;
    const changed = await saveM365Settings(notify_here === true ? { ...rest, notify_origin: await publicOrigin(req) } : rest, { actor: actorFrom(gate), ip: ipFrom(req) });
    return NextResponse.json({ view: await view(req), changed });
  } catch (e) {
    return refuse(e);
  }
}

export async function DELETE(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  await removeM365Connection({ actor: actorFrom(gate), ip: ipFrom(req) });
  return NextResponse.json({ view: await view(req) });
}

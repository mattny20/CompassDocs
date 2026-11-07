// GET /api/helpdesk/admin/chat → HdChatSettingsView (no secret in it: secret_set /
//     signing_secret_set only), with the workspace's address for the endpoint URLs.
// PUT /api/helpdesk/admin/chat   { teams?: { app_id?, secret?, tenant_id?, abilities?, disconnect? },
//                                  slack?: { bot_token?, signing_secret?, abilities?, disconnect? },
//                                  channels? } → the view.
//     A saved secret is kept when the field is left empty; a new app ID needs the secret
//     again. Saving never calls Microsoft or Slack (Test does). A new app, tenant or
//     workspace, or a disconnect, forgets that app's links, threads and cards.
//     Audited (helpdesk.chat.settings_changed / helpdesk.chat.disconnected) with the names
//     of what changed, never a secret.
// Helpdesk 1.19.4 (lib/helpdesk/chat; mock-up f1): Desk settings → Chat apps. Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { hq } from "@/lib/helpdesk/db-core";
import { helpdeskOrigin } from "@/lib/helpdesk/email";
import { publicOrigin } from "@/lib/oauth";
import { ChatSettingsError, chatSettingsView, saveChatSettings } from "@/lib/helpdesk/chat/settings";

export const dynamic = "force-dynamic";

async function origin(req: Request): Promise<string> {
  return (await helpdeskOrigin(await publicOrigin(req).catch(() => ""))) || "";
}

export async function GET(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await chatSettingsView(await origin(req)));
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  const teams = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams")).map((r) => r.id));
  try {
    const { changed, reset } = await saveChatSettings(b, gate.name || gate.username, teams);
    const view = await chatSettingsView(await origin(req));
    if (changed.length) {
      const disconnected = changed.filter((c) => c.endsWith(".disconnected"));
      await audit({
        actor: actorFrom(gate),
        action: disconnected.length ? "helpdesk.chat.disconnected" : "helpdesk.chat.settings_changed",
        targetType: "helpdesk_settings",
        targetId: "chat",
        targetLabel: "Chat apps",
        details: {
          changed,
          ...(reset.length ? { links_forgotten: reset } : {}),
          teams: { connected: view.teams.connected, app_id: view.teams.app_id || null, tenant_id: view.teams.tenant_id || null, abilities: view.teams.abilities },
          slack: { connected: view.slack.connected, abilities: view.slack.abilities },
          channels: view.channels.map((c) => ({ app: c.app, name: c.name, team_id: c.team_id, trigger: c.trigger, reaction: c.reaction || undefined })),
        },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json(view);
  } catch (e) {
    if (e instanceof ChatSettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

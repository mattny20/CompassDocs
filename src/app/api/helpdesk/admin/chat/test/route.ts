// POST /api/helpdesk/admin/chat/test  { app: 'teams' | 'slack' } → { ok, message, settings }
// Helpdesk 1.19.4 (lib/helpdesk/chat/test): proves the saved credentials with the
// platform (Teams: a bot token and the signing keys; Slack: auth.test and the
// token's scopes). The result is shown under the card and audited
// (helpdesk.chat.tested), never with a secret. Desk capability settings.manage.
// Limited to 10 a minute per person.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { helpdeskOrigin } from "@/lib/helpdesk/email";
import { publicOrigin } from "@/lib/oauth";
import { isChatApp, HD_CHAT_APP_LABEL } from "@/lib/helpdesk/chat-shared";
import { chatSettingsView } from "@/lib/helpdesk/chat/settings";
import { testChatApp } from "@/lib/helpdesk/chat/test";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-chat-test:${gate.id}`, 10, 60_000)) return tooMany();
  const b = await readJson(req, 4 * 1024);
  if (!b || !isChatApp(b.app)) return NextResponse.json({ error: "Choose Teams or Slack." }, { status: 400 });
  const r = await testChatApp(b.app);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.chat.tested",
    targetType: "helpdesk_settings",
    targetId: "chat",
    targetLabel: `Chat apps: ${HD_CHAT_APP_LABEL[b.app]}`,
    details: { app: b.app, ok: r.ok },
    ip: ipFrom(req),
  });
  const settings = await chatSettingsView((await helpdeskOrigin(await publicOrigin(req).catch(() => ""))) || "");
  return NextResponse.json({ ...r, settings });
}

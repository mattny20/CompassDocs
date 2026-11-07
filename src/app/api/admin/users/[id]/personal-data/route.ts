// GET /api/admin/users/[id]/personal-data → a JSON download of what CompassDocs holds
// about one person that is theirs to receive. 1.19.1: the helpdesk part only
// (lib/helpdesk/retention personalHelpdeskExport: their requests, the answers they
// gave and the public conversation, never internal notes), and only while Desk
// settings → Retention and privacy → "Include tickets in a person's data export" is
// on. Needs user.delete (the right that handles a person's erasure, as for
// anonymise-compliance) and is audited (user.personal_data_exported). 1.19.4: plus
// their desk background (their choice and their own uploaded artwork, as a data URL),
// whatever the tickets setting says: it is theirs, not a ticket. 1.20.0: plus the
// person's own Claude in the desk chats (claude_in_the_desk), likewise always theirs.

import { NextResponse } from "next/server";
import { getUserById } from "@/lib/db";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { personalHelpdeskExport } from "@/lib/helpdesk/retention";
import { deskArtForExport } from "@/lib/helpdesk/appearance";
import { claudeChatsForExport } from "@/lib/helpdesk/claude/chats";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard("admin", "user.delete");
  if (gate instanceof NextResponse) return gate;
  const admin = gate as SessionUser;
  const { id } = await params;
  const target = await getUserById(Number(id));
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  const helpdesk = await personalHelpdeskExport(target.id);
  // 1.19.4 (C5): their desk background choice and own artwork, with the picture (lib/helpdesk/appearance).
  const deskBackground = await deskArtForExport(target.id);
  // 1.20.0: their own Claude in the desk chats (their questions and Claude's answers), always theirs to receive.
  const claudeChats = await claudeChatsForExport(target.id);
  await audit({
    actor: actorFrom(admin),
    action: "user.personal_data_exported",
    targetType: "user",
    targetId: target.id,
    targetLabel: target.username,
    details: {
      helpdesk_requests: helpdesk.requests.length,
      helpdesk_included: helpdesk.included,
      desk_background: !!deskBackground?.own_artwork,
      claude_chats: claudeChats.length,
    },
    ip: ipFrom(req),
  });
  const body = {
    exported_at: new Date().toISOString(),
    person: { username: target.username, name: target.name, email: target.email },
    helpdesk,
    ...(deskBackground ? { desk_background: deskBackground } : {}),
    ...(claudeChats.length ? { claude_in_the_desk: claudeChats } : {}),
  };
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="personal-data-${target.username.replace(/[^A-Za-z0-9._-]/g, "_")}.json"`,
      "cache-control": "no-store",
    },
  });
}

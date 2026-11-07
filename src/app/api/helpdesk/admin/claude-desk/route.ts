// GET /api/helpdesk/admin/claude-desk  → ClaudeDeskAdminView (settings, teams, this month's usage)
// PUT /api/helpdesk/admin/claude-desk  { enabled?, teams_off?, caps?, web_domains?, web_max_uses?,
//                                        limit_workspace_usd?, limit_agent_usd? } → ClaudeDeskAdminView
//
// Helpdesk 1.20.0, Desk settings → Claude in the desk (mock c3; lib/helpdesk/claude).
// Desk capability settings.manage. The API key and the model are Settings → AI's
// and are never read or returned here (only whether a key is ready). Audited as
// helpdesk.settings.updated { section: "claude_desk", changed } (names of the
// changed settings, never the key).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { getAiModel, getAiProvider, modelLabel } from "@/lib/ai-config";
import { claudeKeyReady, getClaudeDeskConfig, saveClaudeDeskConfig, webSearchAvailable } from "@/lib/helpdesk/claude/config";
import { usageSummary } from "@/lib/helpdesk/claude/usage";
import { validateClaudeDeskPatch, type ClaudeDeskAdminView } from "@/lib/helpdesk/claude/shared";

export const dynamic = "force-dynamic";

async function view(): Promise<ClaudeDeskAdminView> {
  const { listTeams } = await import("@/lib/helpdesk/teams");
  const [config, teams, usage, model, provider, keyReady] = await Promise.all([getClaudeDeskConfig(), listTeams(), usageSummary(), getAiModel(), getAiProvider(), claudeKeyReady()]);
  return {
    config,
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    usage,
    model,
    model_label: modelLabel(model),
    key_ready: keyReady,
    provider,
    web_available: provider === "anthropic" && webSearchAvailable(model),
  };
}

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 16 * 1024);
  const v = validateClaudeDeskPatch(body);
  if (!v.ok) return badRequest(v.error);
  const { changed } = await saveClaudeDeskConfig(v.value);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.settings.updated",
      targetType: "helpdesk_settings",
      targetLabel: "Claude in the desk",
      details: { section: "claude_desk", changed },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(await view());
}

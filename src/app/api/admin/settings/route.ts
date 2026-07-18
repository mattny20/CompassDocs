import { NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { getAppSettings, updateAppSettings } from "@/lib/settings-store";
import type { AppSettings } from "@/lib/settings";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getAppSettings());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body?.approval_mode !== undefined) {
    const mode = body.approval_mode === "open" ? "open" : "strict";
    await setSetting("approval_mode", mode);
    await audit({
      actor: actorFrom(gate),
      action: "settings.approval_mode",
      details: { mode },
      ip: ipFrom(req),
    });
  }

  // Appearance & workspace settings (all optional; validated/clamped in the lib).
  const keys: (keyof AppSettings)[] = [
    "company_name",
    "logo_url",
    "accent_color",
    "timezone",
    "date_format",
    "time_format",
    "session_timeout_minutes",
    "trash_retention_days",
    "backup_frequency",
    "backup_keep",
    "max_attachment_mb",
    "comments_enabled",
    "comments_blocked_words",
  ];
  const patch: Partial<AppSettings> = {};
  for (const k of keys) {
    if (body?.[k] !== undefined) (patch as any)[k] = body[k];
  }
  const settings = Object.keys(patch).length ? await updateAppSettings(patch) : undefined;
  if (settings) {
    await audit({
      actor: actorFrom(gate),
      action: "settings.workspace",
      details: { fields: Object.keys(patch) },
      ip: ipFrom(req),
    });
  }

  return NextResponse.json({ ok: true, settings });
}

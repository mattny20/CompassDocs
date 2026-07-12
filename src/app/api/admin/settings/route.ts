import { NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import { getAppSettings, updateAppSettings } from "@/lib/settings-store";
import type { AppSettings } from "@/lib/settings";
import { apiGuard } from "@/lib/api-auth";

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
  }

  // Appearance & workspace settings (all optional; validated/clamped in the lib).
  const keys: (keyof AppSettings)[] = [
    "company_name",
    "logo_url",
    "timezone",
    "date_format",
    "time_format",
    "session_timeout_minutes",
    "trash_retention_days",
  ];
  const patch: Partial<AppSettings> = {};
  for (const k of keys) {
    if (body?.[k] !== undefined) (patch as any)[k] = body[k];
  }
  const settings = Object.keys(patch).length ? await updateAppSettings(patch) : undefined;

  return NextResponse.json({ ok: true, settings });
}

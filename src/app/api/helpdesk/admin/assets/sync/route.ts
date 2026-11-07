// POST /api/helpdesk/admin/assets/sync { provider?: "snipeit" | "intune" } → { ok, seen, error, running, settings }.
// Sync now: a full sync of Snipe-IT (or, with provider "intune", Microsoft Intune, 1.19.4) into the cache, whatever the time since the last one (409 while
// one is running). It answers within 20 seconds; a larger estate carries on syncing after the
// answer (running: true) and the page polls the settings. Audited (helpdesk.assets.synced). Helpdesk 1.19.3 (lib/helpdesk/assets).
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { activeProviders, assetSettingsView, intuneSourceCheck, providerBase, syncProvider } from "@/lib/helpdesk/assets";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = (await readJson(req, 1024)) ?? {};
  const want = b.provider === "intune" ? "intune" : "snipeit";
  if (want === "intune") await intuneSourceCheck();
  const p = (await activeProviders()).find((x) => providerBase(x.key) === want);
  if (!p) {
    return NextResponse.json(
      { error: want === "intune" ? "Turn Intune on first." : "Connect Snipe-IT first: its address and API key." },
      { status: 409 }
    );
  }
  const run = syncProvider(p.key, { force: true });
  const r = await Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000))]);
  if (r?.skipped === "running") return NextResponse.json({ error: "A sync is already running. It finishes on its own." }, { status: 409 });
  await audit({
    actor: actorFrom(gate),
    action: want === "intune" ? "helpdesk.assets.intune_synced" : "helpdesk.assets.synced",
    targetType: "helpdesk_settings",
    targetId: "assets",
    targetLabel: `Assets: ${p.label}`,
    details: r ? { ok: !!r.ok, seen: r.seen ?? null, removed: r.removed ?? null, error: r.error ?? null } : { running: true },
    ip: ipFrom(req),
  });
  if (!r) run.catch(() => {});
  return NextResponse.json({ ok: r ? !!r.ok : null, seen: r?.seen ?? 0, error: r?.error ?? null, running: !r, settings: await assetSettingsView() });
}

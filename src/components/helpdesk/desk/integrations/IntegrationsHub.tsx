"use client";

// Desk settings → Integrations (1.20.2): the hub. Everything the helpdesk
// connects to, as tiles grouped by what it is for (Assets, Chat, Claude,
// Developers, Alerts and monitoring); each tile says how that integration
// stands (Connected, Not set up, Needs attention: read from its own page's
// data, lib/helpdesk/integrations-hub) and opens its own page, which leads
// back here. A person sees only the tiles their desk role opens.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, Bot, ExternalLink, KeyRound, Laptop, MessageCircle, MessagesSquare, Package, Plug, SlidersHorizontal, Sparkle, Webhook, type LucideIcon } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { Chip, type ChipTone } from "@/components/Chip";
import { EmptyState } from "@/components/form";
import { SectionHeading } from "@/components/Heading";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { HUB_GROUPS, HUB_TILES, type HubStatus, type HubTileKey, type HubTileState } from "@/lib/helpdesk/integrations-hub-shared";
import { getJson } from "../api";

const ICON: Record<HubTileKey, LucideIcon> = {
  "snipe-it": Package,
  intune: Laptop,
  assets: SlidersHorizontal,
  teams: MessagesSquare,
  slack: MessageCircle,
  "claude-connector": Bot,
  "claude-desk": Sparkle,
  "api-tokens": KeyRound,
  webhooks: Webhook,
  alerts: Bell,
};

const STATUS: Record<Exclude<HubStatus, "none">, { tone: ChipTone; label: string }> = {
  connected: { tone: "ok", label: "Connected" },
  not_set_up: { tone: "neutral", label: "Not set up" },
  attention: { tone: "warn", label: "Needs attention" },
};

export function IntegrationsHub() {
  const [tiles, setTiles] = useState<Partial<Record<HubTileKey, HubTileState>> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    getJson<{ tiles: Partial<Record<HubTileKey, HubTileState>> }>("/api/helpdesk/admin/integrations/hub", "Couldn't load the integrations.")
      .then((d) => live && setTiles(d.tiles ?? {}))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const groups = HUB_GROUPS.map((g) => ({ ...g, tiles: HUB_TILES.filter((t) => t.group === g.key && tiles?.[t.key]) })).filter((g) => g.tiles.length);

  return (
    <PageContainer>
      <PageHeader icon={<Plug />} title="Integrations" subtitle="Everything the helpdesk connects to: where devices come from, the chat apps, Claude, the API, and the tools that open tickets by themselves." />
      {error && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {!tiles && !error && <LoadingRow className="py-10" />}
      {tiles && groups.length === 0 && <EmptyState icon={<Plug />} title="No integrations to manage" body="Your desk role doesn't open any of the integration pages. Ask a helpdesk admin if you need one." action={{ href: "/desk", label: "Back to tickets" }} />}
      <div className="flex flex-col gap-8">
        {groups.map((g) => (
          <section key={g.key} aria-labelledby={`hub-${g.key}`} data-testid={`hub-group-${g.key}`}>
            <SectionHeading id={`hub-${g.key}`}>{g.title}</SectionHeading>
            <ul role="list" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {g.tiles.map((t) => {
                const state = tiles![t.key]!;
                const Icon = ICON[t.key];
                const chip = state.status === "none" ? null : STATUS[state.status];
                const setup = state.status === "not_set_up";
                return (
                  <li key={t.key} className={`${CARD_CLASS} flex flex-col p-5`} data-testid={`hub-tile-${t.key}`} data-status={state.status}>
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
                        <Icon className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold text-slate-900">{t.name}</h3>
                        <p className="text-xs text-slate-500">{t.category}</p>
                      </div>
                      {chip && (
                        <Chip tone={chip.tone} size="sm">
                          {chip.label}
                        </Chip>
                      )}
                    </div>
                    <p className="mt-3 text-sm text-slate-600">{t.description}</p>
                    {state.note && <p className={`mt-1 text-xs ${state.status === "attention" ? "ink-warn" : "text-slate-500"}`}>{state.note}</p>}
                    <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
                      <Link href={t.href} className={buttonClass("secondary", "sm")}>
                        {setup ? ("setup" in t && t.setup) || "Set up" : "Open"}
                        <span className="sr-only"> {t.name}</span>
                      </Link>
                      {"docs" in t && t.docs && (
                        <a href={t.docs} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
                          Docs
                          <ExternalLink className="h-3 w-3" aria-hidden />
                          <span className="sr-only">
                            {" "}
                            for {t.name} (opens in a new tab)
                          </span>
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </PageContainer>
  );
}

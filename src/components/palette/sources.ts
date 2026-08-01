"use client";

// Where palette results come from. Local sources (commands, nav, spaces,
// recents) score instantly against what's already in memory; remote sources
// (documents, people) hit an API and are debounced and abortable by the
// caller. New surfaces can register their own source without touching the
// palette component.

import type { SearchHit } from "@/lib/types";
import type { PaletteItem } from "@/lib/palette-types";
import { bestScore, SCORE_FLOOR } from "@/lib/palette-score";
import { NAV_ITEMS, type CapKey } from "@/lib/nav-items";
import { PALETTE_COMMANDS } from "@/lib/palette-commands";
import type { PageCommand } from "./palette-store";

export interface SpaceLite {
  id: number;
  name: string;
  slug: string;
  icon?: string;
  category?: string | null;
}

export interface RecentDoc {
  id: number;
  title: string;
  space_name: string;
  space_icon?: string;
}

export interface PersonHit {
  id: number;
  name: string;
  title?: string;
  department?: string;
  email?: string;
  has_photo?: boolean;
}

export interface SourceContext {
  query: string;
  allowedNav: (cap: CapKey | null) => boolean;
  commandIds: Set<string>;
  spaces: SpaceLite[];
  recents: RecentDoc[];
  pageCommands: PageCommand[];
  /** Ids most recently activated, best first — used to break score ties. */
  frecency: (id: string) => number;
}

const LIMIT_PER_GROUP = 6;

function take(items: PaletteItem[]): PaletteItem[] {
  return items
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, LIMIT_PER_GROUP);
}

/** Actions: static commands the user is allowed, plus this page's own. */
export function commandItems(ctx: SourceContext): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const c of PALETTE_COMMANDS) {
    if (!ctx.commandIds.has(c.id)) continue;
    const m = bestScore(ctx.query, [
      { text: c.label, weight: 1, primary: true },
      { text: c.keywords, weight: 0.55 },
    ]);
    if (!m || m.score < SCORE_FLOOR) continue;
    out.push({
      id: `command:${c.id}`,
      kind: "command",
      label: c.label,
      sub: c.hint,
      href: c.href,
      ranges: m.ranges,
      hint: c.keyHint,
      score: m.score + ctx.frecency(`command:${c.id}`),
    });
  }
  for (const p of ctx.pageCommands) {
    const m = bestScore(ctx.query, [
      { text: p.label, weight: 1, primary: true },
      { text: p.keywords ?? "", weight: 0.55 },
    ]);
    if (!m || m.score < SCORE_FLOOR) continue;
    out.push({
      id: `page:${p.id}`,
      kind: "command",
      label: p.label,
      run: p.run,
      ranges: m.ranges,
      hint: p.hotkey,
      // This page's own actions are the most contextual thing on offer.
      score: m.score + 60,
    });
  }
  return take(out);
}

/** Go to: navigation destinations this user can reach. */
export function navItems(ctx: SourceContext): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const n of NAV_ITEMS) {
    if (!ctx.allowedNav(n.cap)) continue;
    const m = bestScore(ctx.query, [
      { text: n.label, weight: 1, primary: true },
      { text: n.keywords, weight: 0.55 },
    ]);
    if (!m || m.score < SCORE_FLOOR) continue;
    out.push({
      id: `nav:${n.href}`,
      kind: "nav",
      label: n.label,
      href: n.href,
      ranges: m.ranges,
      hint: n.chord ? `g ${n.chord}` : undefined,
      score: m.score + ctx.frecency(`nav:${n.href}`),
    });
  }
  return take(out);
}

export function spaceItems(ctx: SourceContext): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const s of ctx.spaces) {
    const m = bestScore(ctx.query, [
      { text: s.name, weight: 1, primary: true },
      { text: s.category ?? "", weight: 0.4 },
    ]);
    if (!m || m.score < SCORE_FLOOR) continue;
    out.push({
      id: `space:${s.id}`,
      kind: "space",
      label: s.name,
      sub: s.category ?? undefined,
      href: `/spaces/${s.slug}`,
      emoji: s.icon,
      ranges: m.ranges,
      score: m.score + ctx.frecency(`space:${s.id}`),
    });
  }
  return take(out);
}

/** Recently viewed documents — the empty-query default. */
export function recentItems(ctx: SourceContext): PaletteItem[] {
  if (ctx.query) return [];
  return ctx.recents.slice(0, LIMIT_PER_GROUP).map((r) => ({
    id: `recent:${r.id}`,
    kind: "recent" as const,
    label: r.title,
    sub: r.space_name,
    href: `/doc/${r.id}`,
    emoji: r.space_icon,
  }));
}

export function docItems(hits: SearchHit[]): PaletteItem[] {
  return hits.map((h) => ({
    id: `doc:${h.id}`,
    kind: "doc" as const,
    label: h.title,
    sub: h.space_name,
    href: `/doc/${h.id}`,
    emoji: h.space_icon,
    snippetHtml: h.snippet || undefined,
  }));
}

export function personItems(people: PersonHit[]): PaletteItem[] {
  return people.map((p) => ({
    id: `person:${p.id}`,
    kind: "person" as const,
    label: p.name,
    sub: [p.title, p.department].filter(Boolean).join(" · ") || p.email,
    href: `/directory/${p.id}`,
    photoId: p.has_photo ? p.id : undefined,
  }));
}

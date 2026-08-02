"use client";

// Opening the palette from anywhere, and letting a page contribute its own
// commands while it is mounted. Uses the same window-CustomEvent idiom as
// components/Toasts — no second React context around the whole app.

import { useEffect } from "react";
import type { PaletteMode } from "@/lib/palette-types";
import type { LucideIcon } from "lucide-react";

const OPEN_EVENT = "cdc:palette";
const PAGE_COMMANDS_EVENT = "cdc:palette-commands";

export interface PageCommand {
  id: string;
  label: string;
  icon?: LucideIcon;
  keywords?: string;
  /** Single-key hotkey (bare, guarded) — e.g. "e" for Edit. */
  hotkey?: string;
  run: () => void | Promise<void>;
}

/** Open the palette, optionally in a mode and pre-seeded with a query. */
export function openPalette(mode: PaletteMode = "all", seed = ""): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { mode, seed } }));
}

export interface PaletteOpenDetail {
  mode: PaletteMode;
  seed: string;
}

export function onPaletteOpen(fn: (d: PaletteOpenDetail) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<PaletteOpenDetail>).detail);
  window.addEventListener(OPEN_EVENT, h);
  return () => window.removeEventListener(OPEN_EVENT, h);
}

// --- page-scoped commands -------------------------------------------------
// A page (e.g. a document) registers commands that only make sense while it's
// open. Kept in a module-level map keyed by scope so remounts replace rather
// than duplicate, and cleared on unmount.

const pageCommands = new Map<string, PageCommand[]>();

function publish() {
  window.dispatchEvent(new CustomEvent(PAGE_COMMANDS_EVENT));
}

export function currentPageCommands(): PageCommand[] {
  return [...pageCommands.values()].flat();
}

export function onPageCommandsChange(fn: () => void): () => void {
  window.addEventListener(PAGE_COMMANDS_EVENT, fn);
  return () => window.removeEventListener(PAGE_COMMANDS_EVENT, fn);
}

/**
 * Register commands for as long as the calling component is mounted.
 * `key` scopes them (e.g. `doc:42`), so navigating between documents swaps
 * the set instead of accumulating.
 */
export function usePageCommands(key: string, commands: PageCommand[]): void {
  // The command list is rebuilt every render by callers; comparing ids keeps
  // us from publishing (and re-rendering the palette) on every keystroke.
  const signature = commands.map((c) => c.id).join("|");
  useEffect(() => {
    pageCommands.set(key, commands);
    publish();
    return () => {
      pageCommands.delete(key);
      publish();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, signature]);
}

"use client";

// The palette's help mode (`?`): every shortcut this user actually has.
//
// Generated from the registries rather than hand-written, so a new binding can
// never be missing here — NAV_ITEMS supplies the `g` chords, PALETTE_COMMANDS
// supplies the action keys, and only the palette's own in-panel keys are
// literal (nothing else owns them).
//
// Gating mirrors the palette itself: nav chords by capability, commands by the
// server-computed id allow-list. Listing a shortcut the user cannot use would
// be an invitation to a 403.
//
// Modifier labels all go through <Kbd keys={["Mod", …]} />, which resolves via
// modLabel() — a Windows or Linux reader sees "Ctrl K", never "⌘K". The typed
// mode prefixes (@ > # ?) are plain characters and carry no platform text:
// they are produced by the layout, including via AltGr, which lib/hotkeys
// explicitly lets through.

import { useMemo } from "react";
import type { CapKey } from "@/lib/nav-items";
import { NAV_ITEMS } from "@/lib/nav-items";
import { PALETTE_COMMANDS } from "@/lib/palette-commands";
import { Kbd, MOD_KEY } from "./Kbd";

/**
 * The capability bag, redeclared here because lib/nav-capabilities is
 * `import "server-only"` and this is a client component. Optional keys so a
 * NavCapabilities and a plain Record<string, boolean> both satisfy it; a
 * missing key reads as "not allowed", which is the safe default.
 */
export type ShortcutCaps = Partial<Record<CapKey, boolean>>;

interface Shortcut {
  keys: string[];
  label: string;
  /** Extra words the sheet's own search should match. */
  terms?: string;
}

interface ShortcutGroup {
  title: string;
  note?: string;
  rows: Shortcut[];
}

/**
 * Opening the palette. These belong to the global hotkey layer itself, so there
 * is no registry entry to generate them from.
 */
const OPEN_SHORTCUTS: Shortcut[] = [
  { keys: [MOD_KEY, "k"], label: "Open the command palette", terms: "search find spotlight" },
  { keys: ["/"], label: "Search documents", terms: "find pages" },
  { keys: ["@"], label: "Search people", terms: "directory staff who" },
  { keys: [">"], label: "Run an action", terms: "commands do" },
  { keys: ["#"], label: "Jump to a space", terms: "spaces areas teams" },
];

/** Keys that only mean something while the palette is on screen. */
const IN_PALETTE_SHORTCUTS: Shortcut[] = [
  { keys: ["ArrowUp", "ArrowDown"], label: "Move between results", terms: "arrows up down navigate" },
  { keys: ["Enter"], label: "Open the highlighted result", terms: "return go activate" },
  { keys: [MOD_KEY, "Enter"], label: "Open it in a new tab", terms: "return background window" },
  { keys: ["Tab"], label: "Next mode", terms: "cycle switch filter all actions people spaces" },
  { keys: ["Shift", "Tab"], label: "Previous mode", terms: "cycle switch filter back" },
  { keys: ["Backspace"], label: "Clear the mode filter", terms: "delete remove chip back" },
  { keys: ["Escape"], label: "Close the palette", terms: "esc dismiss cancel exit" },
];

/** Modifier caps read under several names; let the sheet's search find them. */
const KEY_TERMS: Record<string, string> = {
  [MOD_KEY]: "mod cmd command ctrl control ⌘",
  Shift: "shift ⇧",
  Enter: "enter return ↵",
  Escape: "escape esc",
  Tab: "tab ⇥",
  Backspace: "backspace delete ⌫",
  ArrowUp: "up arrow ↑",
  ArrowDown: "down arrow ↓",
};

function haystack(row: Shortcut): string {
  const keyWords = row.keys.map((k) => `${k} ${KEY_TERMS[k] ?? ""}`).join(" ");
  return `${row.label} ${row.terms ?? ""} ${keyWords}`.toLowerCase();
}

export function ShortcutSheet({
  caps,
  commandIds,
  companyName,
  query = "",
}: {
  /** The server-evaluated capability bag; gates the `g` chords. */
  caps: ShortcutCaps;
  /** The server-computed command allow-list; gates the action keys. */
  commandIds: readonly string[];
  /** Renders the workspace's name on the Ask destination, as the nav does. */
  companyName?: string;
  /** The palette's search box, so `?` then "train" finds `g t`. */
  query?: string;
}) {
  const groups = useMemo<ShortcutGroup[]>(() => {
    const allowedCommands = new Set(commandIds);

    const commandRows: Shortcut[] = PALETTE_COMMANDS.filter(
      (c) => c.keyHint && allowedCommands.has(c.id)
    ).map((c) => ({ keys: [c.keyHint as string], label: c.label, terms: c.keywords }));

    const navRows: Shortcut[] = NAV_ITEMS.filter(
      (i) => i.chord && (i.cap === null || caps[i.cap] === true)
    ).map((i) => ({
      keys: ["g", i.chord as string],
      // "/search" is the one destination whose name follows the workspace.
      label: i.href === "/search" && companyName ? `${i.label} ${companyName}` : i.label,
      terms: i.keywords,
    }));

    return [
      {
        title: "Global",
        note: "Anywhere in the app, as long as you are not typing.",
        rows: [...OPEN_SHORTCUTS, ...commandRows],
      },
      {
        title: "Navigate",
        note: "Press G, then the second key. Either case works.",
        rows: navRows,
      },
      { title: "In the palette", rows: IN_PALETTE_SHORTCUTS },
    ];
  }, [caps, commandIds, companyName]);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? groups
        .map((g) => ({ ...g, rows: g.rows.filter((r) => haystack(r).includes(needle)) }))
        .filter((g) => g.rows.length > 0)
    : groups.filter((g) => g.rows.length > 0);

  if (shown.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-slate-400">
        No shortcuts match “{query.trim()}”.
      </div>
    );
  }

  return (
    // No scroll container of its own: the palette's results region already is
    // one, and nesting two means the sheet stops scroll chaining halfway.
    <div className="pb-2">
      {shown.map((group) => (
        <section key={group.title}>
          <h3 className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {group.title}
          </h3>
          {group.note && !needle && (
            <p className="-mt-0.5 mb-1 px-4 text-xs text-slate-400">{group.note}</p>
          )}
          <dl>
            {group.rows.map((row) => (
              <div
                key={`${group.title}:${row.keys.join("+")}:${row.label}`}
                className="flex items-center justify-between gap-4 px-4 py-1.5"
              >
                <dt className="min-w-0 truncate text-sm text-slate-700">{row.label}</dt>
                <dd className="shrink-0">
                  <Kbd keys={row.keys} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

"use client";

// The search affordance in the sidebar. A button, not an input: clicking it
// opens the palette overlay rather than typing in place, which is what makes
// search work identically from a collapsed rail, a phone, or the keyboard.

import { Search } from "lucide-react";
import { openPalette } from "./palette-store";
import { Kbd } from "./Kbd";

export function PaletteTrigger({ collapsed = false }: { collapsed?: boolean }) {
  if (collapsed) {
    return (
      <button
        onClick={() => openPalette()}
        data-tt="Search (Mod K)"
        aria-label="Search"
        className="flex w-full items-center justify-center rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <Search className="h-4 w-4" aria-hidden />
      </button>
    );
  }
  return (
    <button
      onClick={() => openPalette()}
      className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400 transition hover:border-compass-300 hover:text-slate-600"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1 text-left">Search docs…</span>
      <Kbd keys={["Mod", "K"]} />
    </button>
  );
}

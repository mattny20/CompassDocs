"use client";

// Keycap chips for keyboard hints: <Kbd keys={["Mod", "K"]} /> → ⌘ K on a Mac,
// Ctrl K on Windows and Linux.
//
// The `Mod` label comes from `modLabel()` in lib/hotkeys — the single source of
// truth. Never hard-code "⌘" here: this app is not Mac-only, and a Windows user
// reading "⌘K" has been told to press a key their keyboard does not have.
//
// `modLabel()` can only answer in the browser (it reads `navigator`), so it is
// resolved AFTER mount. Calling it during render would make the server HTML and
// the first client render disagree, which React treats as a hydration error.
// Until it resolves, the Mod cap renders a blank — and because "Ctrl" is much
// wider than "⌘", the cap permanently reserves the width of the WIDER label via
// an invisible strut. Nothing jumps when the real label lands, on any platform.
//
// Visuals live in the unlayered `.cmd-kbd` rule in globals.css. These chips are
// the palette's only affordance for shortcuts: the panel is `overflow-hidden`
// and clips `data-tt`, so a tooltip is not an option here (STYLEGUIDE.md).

import { useEffect, useState } from "react";
import { modLabel } from "@/lib/hotkeys";

/** Caps whose glyph is the same everywhere. Anything absent renders verbatim. */
const GLYPH: Record<string, string> = {
  Enter: "↵",
  Return: "↵",
  Escape: "Esc",
  Esc: "Esc",
  Tab: "⇥",
  Shift: "⇧",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

/** The token that stands for "the platform's command modifier". */
export const MOD_KEY = "Mod";

/** The widest label `modLabel()` can return; the Mod cap always reserves it. */
const WIDEST_MOD_LABEL = "Ctrl";

function capLabel(key: string): string {
  const glyph = GLYPH[key];
  if (glyph) return glyph;
  // Letters read better as caps. Presentational only — the handlers match on
  // the lowercase character, so this never implies Shift is part of the chord.
  return /^[a-z]$/.test(key) ? key.toUpperCase() : key;
}

export function Kbd({
  keys,
  className = "",
}: {
  /** Cap names, left to right. "Mod" → ⌘ / Ctrl; see GLYPH for the rest. */
  keys: readonly string[];
  className?: string;
}) {
  // null on the server AND on the first client render, so the two agree.
  const [mod, setMod] = useState<string | null>(null);
  useEffect(() => {
    setMod(modLabel());
  }, []);

  return (
    <span className={`inline-flex items-center gap-1 ${className}`.trim()}>
      {keys.map((key, i) =>
        key === MOD_KEY ? (
          <kbd key={`${key}-${i}`} className="cmd-kbd">
            <span style={{ display: "grid" }}>
              {/* Width strut: holds the cap at "Ctrl" width in every state, so
                  resolving the real label after mount reflows nothing. */}
              <span aria-hidden style={{ gridArea: "1 / 1", visibility: "hidden" }}>
                {WIDEST_MOD_LABEL}
              </span>
              <span style={{ gridArea: "1 / 1", justifySelf: "center" }}>
                {mod ?? "\u00A0"}
              </span>
            </span>
          </kbd>
        ) : (
          <kbd key={`${key}-${i}`} className="cmd-kbd">
            {capLabel(key)}
          </kbd>
        )
      )}
    </span>
  );
}

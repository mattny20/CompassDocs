"use client";

// "Where people find it" (1.18.0), one per Contents row: a pill-shaped menu
// button saying where the document is found now ("Space + handbook", or
// "Handbook only" filled), opening a Popover menu of the two places with a
// sentence each, the chosen one ticked: a single choice, so each option is a
// menuitemradio with aria-checked, and the menu opens with focus on the
// checked one (Popover; arrows walk both). The choice is stored on the document
// (documents.find_mode) and goes with the editor's Save, so it is a choice,
// not a status chip (STYLEGUIDE §Status chips: chips are never pickers).

import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "@/components/Popover";
import type { FindMode } from "@/lib/handbooks";

export const FIND_MODE_LABEL: Record<FindMode, string> = {
  space: "Space + handbook",
  handbook_only: "Handbook only",
};

function options(spaceName: string): { mode: FindMode; title: string; body: string }[] {
  return [
    {
      mode: "space",
      title: "In its space and in handbooks",
      body: `Listed in ${spaceName}, found by search, and read here.`,
    },
    {
      mode: "handbook_only",
      title: "Only through handbooks",
      body: `Hidden from the ${spaceName} page, the sidebar and search for readers. People open it from a handbook they've been given. Editors still see it in the space, marked Handbook only.`,
    },
  ];
}

export function FindModeMenu({
  mode,
  title,
  spaceName,
  disabled = false,
  onChange,
}: {
  mode: FindMode;
  /** The document's title, for the accessible names. */
  title: string;
  spaceName: string;
  disabled?: boolean;
  onChange: (mode: FindMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const only = mode === "handbook_only";

  function pick(next: FindMode) {
    setOpen(false);
    btn.current?.focus();
    if (next !== mode) onChange(next);
  }

  return (
    // Under sm the panel hangs from the row (its <li> is the positioned
    // ancestor), so it spans the row instead of running off the screen.
    <div className="sm:relative">
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tt="Where people find it"
        aria-label={`Where people find ${title}: ${FIND_MODE_LABEL[mode]}`}
        onClick={() => setOpen((o) => !o)}
        // A pill so it reads as the item's setting beside its title; filled
        // when the document is hidden from its space. slate-800 on surface
        // inverts with the theme, so the filled pill stays legible in both.
        className={`inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-medium transition disabled:opacity-60 ${
          only
            ? "bg-slate-800 text-surface hover:bg-slate-700"
            : "border border-slate-200 bg-surface text-slate-600 hover:bg-slate-50"
        }`}
      >
        {FIND_MODE_LABEL[mode]}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={btn}
        role="menu"
        label="Where people find it"
        align="end"
        width="w-[min(22rem,calc(100vw-2rem))]"
        padding="p-1.5"
        className="max-sm:right-2 max-sm:left-2 max-sm:w-auto"
      >
        {options(spaceName).map((o) => {
          const on = o.mode === mode;
          return (
            <button
              key={o.mode}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              onClick={() => pick(o.mode)}
              className={`block w-full rounded-lg px-3 py-2.5 text-left transition ${
                on ? "bg-compass-50 ring-1 ring-inset ring-compass-200" : "hover:bg-slate-50"
              }`}
            >
              <span className={`flex items-center justify-between gap-2 text-sm font-semibold ${on ? "text-compass-700" : "text-slate-900"}`}>
                {o.title}
                {/* aria-checked says it to a screen reader; the tick shows it. */}
                {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
              </span>
              <span className="mt-0.5 block text-[0.8125rem] text-slate-600">{o.body}</span>
            </button>
          );
        })}
      </Popover>
    </div>
  );
}

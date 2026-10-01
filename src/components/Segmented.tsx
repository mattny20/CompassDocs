"use client";

// The one segmented control: a radiogroup of two to five choices where
// exactly one is on (theme, page width, interface scale, Normal/Wide/Full
// on a document). Keyboard-operable the way native radios are — Tab lands
// on the chosen option, arrows move the choice — and styled once, so the
// three recipes it replaced (two filled, one tinted) cannot drift again.

import { useRef } from "react";
import type { LucideIcon } from "lucide-react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Tooltip (data-tt) for the option. */
  hint?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className = "",
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name. */
  label: string;
  /** sm: compact, for toolbars (the document width switch). */
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const known = options.some((o) => o.value === value);

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    const n = options.length;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  const pad = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const glyph = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex items-center gap-0.5 rounded-lg border border-slate-200 bg-surface p-0.5 ${className}`}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: one stop per group, like native radios.
            tabIndex={active || (!known && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            data-tt={o.hint}
            className={`inline-flex items-center gap-1.5 rounded-md font-medium transition ${pad} ${
              active ? "bg-compass-50 text-compass-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
            }`}
          >
            {Icon && <Icon className={glyph} aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

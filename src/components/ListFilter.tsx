"use client";

// The one list filter (STYLEGUIDE §Tables): a search box that narrows a
// list already on the page, with a live "3 of 89" count so the heading and
// the rows always agree. Lookups that fetch ("Search people…") are a
// different control; this one filters what is here.

import { useId } from "react";
import { Search, X } from "lucide-react";
import { TextInput } from "./form";

export function ListFilter({
  value,
  onChange,
  label,
  placeholder,
  shown,
  total,
  noun = "items",
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  /** The accessible name — "Filter users". */
  label: string;
  placeholder?: string;
  /** Rows after filtering. */
  shown: number;
  /** Rows before filtering. */
  total: number;
  /** "users", "spaces", "documents" — for the count. */
  noun?: string;
  className?: string;
}) {
  const countId = useId();
  const active = value.trim().length > 0;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      <div className="relative min-w-56 flex-1 sm:max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <TextInput
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          aria-describedby={countId}
          placeholder={placeholder ?? `Filter ${noun}…`}
          autoComplete="off"
          spellCheck={false}
          className={active ? "pl-9 pr-9" : "pl-9"}
          onKeyDown={(e) => {
            if (e.key === "Escape" && active) {
              e.preventDefault();
              onChange("");
            }
          }}
        />
        {active && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear filter"
            data-tt="Clear"
            className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      <span id={countId} aria-live="polite" className="text-sm tabular-nums text-slate-500">
        {active ? `${shown} of ${total} ${noun}` : `${total} ${noun}`}
      </span>
    </div>
  );
}

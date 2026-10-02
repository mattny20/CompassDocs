"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { controlClass } from "@/components/form";

// Scalable user/group picker for the Settings pages: a searchable combobox
// that stays fast and uncluttered with thousands of entries. Type to filter
// (name, username, email — whatever the caller puts in label/sublabel), pick
// with mouse or keyboard; selections render as removable chips. The dropdown
// caps visible matches and says how many more exist, so no giant lists.
//
// Two modes:
//   - multi:  pass `value` + `onChange` — chips are rendered above the input.
//   - single: pass `onPick` — the input resets after each pick (an "add…" box).
//
// Safe inside a <form>: Enter never submits the form (it opens the list or
// picks the highlighted match), every button is type="button", and `name`
// renders one hidden input per selected id so a native post carries them.

export interface PickerOption {
  id: number;
  label: string;
  sublabel?: string;
}

const MAX_VISIBLE = 40;

export function EntityPicker({
  options,
  value,
  onChange,
  onPick,
  label,
  name,
  placeholder = "Search…",
  emptyText = "Nothing matches.",
  accent = "compass",
  disabled = false,
  maxVisible = MAX_VISIBLE,
}: {
  options: PickerOption[];
  /** Selected ids (multi mode). */
  value?: number[];
  onChange?: (ids: number[]) => void;
  /** Single mode: called with the picked id; the box then clears. */
  onPick?: (id: number) => void;
  /** Accessible name for the search box ("Spaces", "Groups"). A placeholder is an example, not a name. */
  label?: string;
  /** Form field name: renders `<input type="hidden" name value={id}>` per selected id (multi mode). */
  name?: string;
  placeholder?: string;
  emptyText?: string;
  /** Tailwind color family for chips/highlights (compass | violet). */
  accent?: "compass" | "violet";
  disabled?: boolean;
  /** Cap on visible matches before "keep typing" (pass options most-recent-first). */
  maxVisible?: number;
}) {
  const multi = Array.isArray(value) && !!onChange;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = useMemo(() => new Set(value ?? []), [value]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = options.filter((o) => !selected.has(o.id));
    if (!needle) return pool;
    return pool.filter((o) => `${o.label} ${o.sublabel ?? ""}`.toLowerCase().includes(needle));
  }, [options, selected, query]);

  const visible = matches.slice(0, maxVisible);
  const listOpen = open && !disabled;

  useEffect(() => {
    setCursor(0);
  }, [query, open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(id: number) {
    if (multi) {
      onChange!([...(value ?? []), id]);
      setQuery("");
    } else {
      onPick?.(id);
      setQuery("");
      setOpen(false);
    }
  }

  function remove(id: number) {
    if (multi) onChange!((value ?? []).filter((v) => v !== id));
  }

  const chipTone =
    accent === "violet" ? "bg-violet-50 text-violet-800" : "bg-compass-50 text-compass-800";
  const hoverTone = accent === "violet" ? "bg-violet-50" : "bg-compass-50";
  const optionId = (id: number) => `${listId}-opt-${id}`;

  return (
    <div ref={rootRef} className="relative">
      {multi && (value ?? []).length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(value ?? []).map((id) => (
            <span
              key={id}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${chipTone}`}
            >
              {byId.get(id)?.label ?? `#${id}`}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(id)}
                  data-tt="Remove"
                  aria-label={`Remove ${byId.get(id)?.label ?? `#${id}`}`}
                  className="opacity-60 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {multi && name && (value ?? []).map((id) => <input key={id} type="hidden" name={name} value={id} />)}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <input
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Never submit a surrounding form from the search box.
              e.preventDefault();
              if (!open) setOpen(true);
              else if (visible[cursor]) pick(visible[cursor].id);
              return;
            }
            if (!open && e.key === "ArrowDown") {
              setOpen(true);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-label={label}
          aria-expanded={listOpen}
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-activedescendant={listOpen && visible[cursor] ? optionId(visible[cursor].id) : undefined}
          autoComplete="off"
          className={controlClass(false, "pl-8 pr-3")}
        />
      </div>

      {listOpen && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-surface py-1 shadow-float"
        >
          {visible.map((o, i) => (
            <button
              key={o.id}
              type="button"
              id={optionId(o.id)}
              role="option"
              aria-selected={i === cursor}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.id);
              }}
              onMouseEnter={() => setCursor(i)}
              className={`flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm ${
                i === cursor ? hoverTone : ""
              }`}
            >
              <span className="truncate font-medium text-slate-700">{o.label}</span>
              {o.sublabel && (
                <span className="shrink-0 text-xs text-slate-500">{o.sublabel}</span>
              )}
            </button>
          ))}
          {matches.length > maxVisible && (
            <p className="px-3 py-1.5 text-xs text-slate-500">
              {matches.length - maxVisible} more — keep typing to narrow down.
            </p>
          )}
          {visible.length === 0 && <p className="px-3 py-1.5 text-sm text-slate-500">{emptyText}</p>}
        </div>
      )}
    </div>
  );
}

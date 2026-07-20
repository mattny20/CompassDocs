"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

// Scalable user/group picker for the Settings pages: a searchable combobox
// that stays fast and uncluttered with thousands of entries. Type to filter
// (name, username, email — whatever the caller puts in label/sublabel), pick
// with mouse or keyboard; selections render as removable chips. The dropdown
// caps visible matches and says how many more exist, so no giant lists.
//
// Two modes:
//   - multi:  pass `value` + `onChange` — chips are rendered above the input.
//   - single: pass `onPick` — the input resets after each pick (an "add…" box).

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
  placeholder = "Search…",
  emptyText = "Nothing matches.",
  accent = "compass",
  disabled = false,
}: {
  options: PickerOption[];
  /** Selected ids (multi mode). */
  value?: number[];
  onChange?: (ids: number[]) => void;
  /** Single mode: called with the picked id; the box then clears. */
  onPick?: (id: number) => void;
  placeholder?: string;
  emptyText?: string;
  /** Tailwind color family for chips/highlights (compass | violet). */
  accent?: "compass" | "violet";
  disabled?: boolean;
}) {
  const multi = Array.isArray(value) && !!onChange;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => new Set(value ?? []), [value]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = options.filter((o) => !selected.has(o.id));
    if (!needle) return pool;
    return pool.filter((o) => `${o.label} ${o.sublabel ?? ""}`.toLowerCase().includes(needle));
  }, [options, selected, query]);

  const visible = matches.slice(0, MAX_VISIBLE);

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
                  onClick={() => remove(id)}
                  title="Remove"
                  aria-label={`Remove ${byId.get(id)?.label ?? id}`}
                  className="opacity-60 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

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
            if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
              setOpen(true);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (visible[cursor]) pick(visible[cursor].id);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          className="w-full rounded-lg border border-slate-200 bg-surface py-2 pl-8 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-compass-400 disabled:opacity-60"
        />
      </div>

      {open && !disabled && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-surface py-1 shadow-lg">
          {visible.map((o, i) => (
            <button
              key={o.id}
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
                <span className="shrink-0 text-xs text-slate-400">{o.sublabel}</span>
              )}
            </button>
          ))}
          {matches.length > MAX_VISIBLE && (
            <p className="px-3 py-1.5 text-xs text-slate-400">
              {matches.length - MAX_VISIBLE} more — keep typing to narrow down.
            </p>
          )}
          {visible.length === 0 && <p className="px-3 py-1.5 text-sm text-slate-400">{emptyText}</p>}
        </div>
      )}
    </div>
  );
}

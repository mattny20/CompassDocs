"use client";

// The handbook editor's "Add policies" panel (1.18.0, mock-up 1-editor): a
// search over the published documents this person may add (lib/handbooks
// handbookCandidates: a space handbook offers only the spaces they manage),
// narrowed by type (Policies / All types) and space, each result a checkbox
// row. Ticking appends the document to the end of Contents, unticking takes
// it out; both are local until the page's Save, like every other edit.

import { useEffect, useId, useState } from "react";
import { Search } from "lucide-react";
import { Card } from "@/components/Card";
import { CardTitle } from "@/components/Heading";
import { TypeBadge } from "@/components/Badges";
import { SectionEmpty, Select, TextInput } from "@/components/form";
import { Segmented } from "@/components/Segmented";
import { LoadingRow, busyClass } from "@/components/Spinner";
import type { HandbookCandidate } from "@/lib/handbooks";
import { searchCandidates } from "./api";
import { ITEMS_MAX, type DraftSection, hasDoc, itemCount } from "./model";

type TypeFilter = "policy" | "all";

export function AddPoliciesPanel({
  handbookId,
  sections,
  spaces,
  spaceHandbook,
  disabled,
  onToggle,
}: {
  handbookId: number;
  sections: DraftSection[];
  /** The spaces the filter offers. */
  spaces: { id: number; name: string; icon: string }[];
  /** A space handbook draws only on the spaces its owner manages. */
  spaceHandbook: boolean;
  disabled: boolean;
  onToggle: (candidate: HandbookCandidate, on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("policy");
  const [space, setSpace] = useState("");
  const [rows, setRows] = useState<HandbookCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const countId = useId();

  // Debounced, and the previous request is abandoned, so a fast typist
  // never sees an older answer land after a newer one.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await searchCandidates(handbookId, { q, type, spaceId: space ? Number(space) : null }, ctrl.signal);
        if (res.ok) {
          setRows(res.value);
          setError("");
        } else setError(res.error);
        setLoading(false);
      } catch {
        /* aborted: a newer search owns the panel */
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [handbookId, q, type, space]);

  const total = itemCount(sections);
  const full = total >= ITEMS_MAX;

  return (
    <Card padding="none" as="div" className="lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-3rem)] lg:flex-col">
      <div className="px-4 pt-4 pb-3">
        <CardTitle>Add policies</CardTitle>
        <p className="mt-0.5 text-xs text-slate-500">
          {spaceHandbook ? "From the spaces you manage." : "From every space you can see."} Only published documents.
        </p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <TextInput
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            aria-describedby={countId}
            className="pl-9"
          />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Segmented<TypeFilter>
            size="sm"
            label="Document type"
            value={type}
            onChange={setType}
            options={[
              { value: "policy", label: "Policies" },
              { value: "all", label: "All types" },
            ]}
          />
          {spaces.length > 1 && (
            <Select dense aria-label="Space" value={space} onChange={(e) => setSpace(e.target.value)} className="w-auto max-w-full text-xs">
              <option value="">All spaces</option>
              {spaces.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.icon ? `${s.icon} ${s.name}` : s.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto border-t border-slate-100 ${busyClass(loading && rows !== null)}`} aria-busy={loading}>
        {rows === null ? (
          error ? (
            <p role="alert" className="px-4 py-6 text-sm text-red-600">
              {error}
            </p>
          ) : (
            <LoadingRow>Searching…</LoadingRow>
          )
        ) : rows.length === 0 ? (
          <SectionEmpty className="px-4 py-6">
            {q.trim() ? "No published documents match your search." : type === "policy" ? "No published policies here. Try All types." : "No published documents here."}
          </SectionEmpty>
        ) : (
          <ul aria-label="Search results">
            {rows.map((c) => {
              const on = hasDoc(sections, c.id);
              return (
                <li key={c.id} className="border-b border-slate-100 last:border-b-0">
                  <label className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50 ${disabled || (full && !on) ? "cursor-not-allowed opacity-60" : ""}`}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0"
                      checked={on}
                      disabled={disabled || (full && !on)}
                      onChange={(e) => onToggle(c, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{c.title}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {c.space_icon && <span aria-hidden>{c.space_icon} </span>}
                        {c.space_name}
                      </span>
                    </span>
                    <TypeBadge type={c.type} />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {error && rows !== null && (
          <p role="alert" className="px-4 py-2 text-xs text-red-600">
            {error}
          </p>
        )}
      </div>

      <p id={countId} className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500" aria-live="polite">
        {total} selected · {full ? `a handbook holds up to ${ITEMS_MAX} policies` : "ticking adds to the end of Contents"}
      </p>
    </Card>
  );
}

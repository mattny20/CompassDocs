"use client";

// Search box scoped to a single space: results replace the document grid
// while a query is active, and clearing the box brings the grid back.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { TypeBadge } from "./Badges";

interface Hit {
  id: number;
  title: string;
  type: string;
  status: string;
  snippet: string;
}

// ts_headline output is escaped server-side except <mark> — safe to inject.
function Snippet({ html }: { html: string }) {
  return (
    <p
      className="mt-1 text-sm text-slate-500 [&_mark]:rounded [&_mark]:px-0.5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function SpaceSearch({
  spaceId,
  spaceName,
  children,
}: {
  spaceId: number;
  spaceName: string;
  /** The normal space content, hidden while a search is active. */
  children: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) {
      setHits(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}&space_id=${spaceId}&limit=25`
        );
        if (res.ok) setHits((await res.json()).hits);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, spaceId]);

  return (
    <>
      <div className="relative mb-6">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search in ${spaceName}…`}
          aria-label={`Search documents in ${spaceName}`}
          className="w-full rounded-xl border border-slate-200 bg-surface py-2.5 pl-10 pr-10 text-sm shadow-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {hits === null ? (
        children
      ) : (
        <div>
          <p className="mb-3 text-sm text-slate-400">
            {busy ? "Searching…" : `${hits.length} result${hits.length === 1 ? "" : "s"} in ${spaceName}`}
          </p>
          {hits.length === 0 && !busy ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-surface p-10 text-center text-slate-500">
              Nothing in {spaceName} matches “{query.trim()}”.
            </div>
          ) : (
            <ul className="space-y-2">
              {hits.map((h) => (
                <li key={h.id}>
                  <Link
                    href={`/doc/${h.id}`}
                    className="block rounded-xl border border-slate-200 bg-surface p-4 shadow-sm transition hover:border-compass-300"
                  >
                    <span className="flex items-center gap-2">
                      <TypeBadge type={h.type as any} />
                      <span className="font-semibold text-slate-900">{h.title}</span>
                      {h.status === "draft" && (
                        <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">draft</span>
                      )}
                    </span>
                    <Snippet html={h.snippet} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

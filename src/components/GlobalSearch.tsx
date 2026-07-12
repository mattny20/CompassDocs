"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { SearchHit } from "@/lib/types";
import { TYPE_LABEL } from "@/lib/ui";

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=6`);
        const data = await res.json();
        setHits(data.hits ?? []);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) {
      setOpen(false);
      router.push(`/search?q=${encodeURIComponent(q.trim())}`);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <form onSubmit={submit}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
          placeholder="Search docs…  (⌘K)"
          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-compass-400 focus:bg-surface focus:ring-2 focus:ring-compass-100"
        />
      </form>

      {open && q.trim().length >= 2 && (
        <div className="absolute z-20 mt-1 w-72 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-lg">
          {loading && hits.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-400">Searching…</div>
          )}
          {!loading && hits.length === 0 && (
            <div className="px-3 py-3 text-sm text-slate-400">No matches.</div>
          )}
          {hits.map((h) => (
            <Link
              key={h.id}
              href={`/doc/${h.id}`}
              onClick={() => setOpen(false)}
              className="block border-b border-slate-50 px-3 py-2 last:border-0 hover:bg-slate-50"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">{h.space_icon}</span>
                <span className="truncate text-sm font-medium text-slate-800">{h.title}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-400">
                {TYPE_LABEL[h.type]} · {h.space_name}
              </div>
            </Link>
          ))}
          {hits.length > 0 && (
            <button
              onClick={submit}
              className="block w-full bg-slate-50 px-3 py-2 text-left text-xs font-medium text-compass-600 hover:bg-slate-100"
            >
              See all results & ask AI →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

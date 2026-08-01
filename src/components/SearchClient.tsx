"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { MarkdownView } from "./MarkdownView";
import { PageContainer } from "./PageWidth";
import { TypeBadge } from "./Badges";
import { timeAgo } from "@/lib/ui";
import { parseSearchQuery } from "@/lib/search-query";
import type { SearchHit } from "@/lib/types";
import type { AiAnswer } from "@/lib/ai";
import { safeSnippet } from "@/lib/snippet";

export function SearchClient({
  initialQuery,
  companyName = "CompassDocs",
}: {
  initialQuery: string;
  companyName?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [asking, setAsking] = useState(false);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setHits(data.hits ?? []);
    } finally {
      setSearching(false);
    }
  }, []);

  const runAsk = useCallback(async (raw: string) => {
    // Operators are for the keyword search — the AI gets the plain question.
    const q = parseSearchQuery(raw).text;
    if (!q.trim()) {
      setAnswer(null);
      return;
    }
    setAsking(true);
    setAnswer(null);
    try {
      const res = await fetch("/api/ai-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      setAnswer(data);
    } catch {
      setAnswer({
        answer: "Something went wrong while asking. Please try again.",
        sources: [],
        people: [],
        mode: "fallback",
      });
    } finally {
      setAsking(false);
    }
  }, []);

  // Run search + ask on initial load if a query was provided.
  useEffect(() => {
    if (initialQuery.trim()) {
      runSearch(initialQuery);
      runAsk(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    setSubmitted(q);
    runSearch(q);
    runAsk(q);
    window.history.replaceState(null, "", `/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <PageContainer>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-bold text-slate-900">
        <Sparkles className="h-6 w-6 text-compass-600" /> Ask {companyName}
      </h1>
      <p className="mb-5 mt-1 text-sm text-slate-500">
        Ask a question in plain English, or search by keyword. Answers are grounded in your
        knowledge base.
      </p>

      <form onSubmit={onSubmit} className="mb-6 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          placeholder="e.g. How do I roll back a bad deploy?"
          className="flex-1 rounded-lg border border-slate-200 bg-surface px-4 py-2.5 text-slate-800 outline-hidden focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
        />
        <button
          type="submit"
          className="rounded-lg bg-compass-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-compass-700"
        >
          Ask
        </button>
      </form>

      {/* Active operator filters as removable chips */}
      {(() => {
        const parsed = parseSearchQuery(submitted);
        if (!parsed.hasFilters) return null;
        const remove = (key: string) => {
          const next = submitted
            .replace(new RegExp(`${key}:(?:"[^"]*"|\\S+)\\s*`, "i"), "")
            .replace(/\s+/g, " ")
            .trim();
          setQuery(next);
          setSubmitted(next);
          runSearch(next);
          window.history.replaceState(null, "", `/search?q=${encodeURIComponent(next)}`);
        };
        return (
          <div className="-mt-3 mb-5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-500">Filters:</span>
            {Object.entries(parsed.filters).map(([k, v]) => (
              <button
                key={k}
                onClick={() => remove(k)}
                data-tt={`Remove ${k} filter`} aria-label={`Remove ${k} filter`}
                className="inline-flex items-center gap-1 rounded-full bg-compass-50 px-2 py-0.5 font-medium text-compass-700 hover:bg-compass-100"
              >
                {k}: {v} <X className="h-3 w-3" aria-hidden />
              </button>
            ))}
          </div>
        );
      })()}

      {/* AI answer */}
      {(asking || answer) && (
        <div className="mb-8 rounded-xl border border-compass-200 bg-linear-to-br from-compass-50/70 to-surface p-5 shadow-xs">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-compass-700">
            <span>✨</span> Answer
            {answer?.mode === "fallback" && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">
                keyword mode
              </span>
            )}
          </div>
          {asking ? (
            <div className="flex items-center gap-2 py-3 text-slate-500">
              <Spinner /> Thinking through your docs…
            </div>
          ) : (
            answer && (
              <>
                <MarkdownView content={answer.answer} />
                {(answer.people?.length ?? 0) > 0 && (
                  <div className="mt-4 border-t border-compass-100 pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      From the people directory
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {answer.people!.map((p) => (
                        <Link
                          key={p.id}
                          href={`/directory/${p.id}`}
                          className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-surface px-3 py-2 hover:border-compass-300"
                        >
                          {p.photo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.photo} alt="" className="h-8 w-8 rounded-full object-cover" />
                          ) : (
                            <span className="grid h-8 w-8 place-items-center rounded-full bg-compass-100 text-xs font-semibold text-compass-700">
                              {p.name.split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("")}
                            </span>
                          )}
                          <span className="text-sm">
                            <span className="block font-medium text-slate-800">{p.name}</span>
                            <span className="block text-xs text-slate-500">
                              {[p.title, p.department].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {answer.sources.length > 0 && (
                  <div className="mt-4 border-t border-compass-100 pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Sources
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {answer.sources.map((s) => (
                        <Link
                          key={s.id}
                          href={`/doc/${s.id}`}
                          className="rounded-lg border border-slate-200 bg-surface px-3 py-1 text-sm text-slate-600 hover:border-compass-300 hover:text-compass-700"
                        >
                          {s.title}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      {/* Keyword results */}
      {submitted && (
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {searching ? "Searching…" : `${hits.length} matching document${hits.length === 1 ? "" : "s"}`}
          </h2>
          <div className="space-y-3">
            {hits.map((h) => (
              <Link
                key={h.id}
                href={`/doc/${h.id}`}
                className="block rounded-xl border border-slate-200 bg-surface p-4 shadow-xs transition hover:border-compass-300 hover:shadow-md"
              >
                <div className="mb-1 flex items-center gap-2">
                  <TypeBadge type={h.type} />
                  <span className="min-w-0 truncate text-sm text-slate-500">
                    {h.space_icon} {h.space_name}
                    {h.path && h.path.length > 0 && ` › ${h.path.join(" › ")}`} ·{" "}
                    {timeAgo(h.updated_at)}
                  </span>
                  {h.match === "semantic" && (
                    <span
                      title="Found by meaning, not keywords"
                      className="inline-flex items-center gap-1 rounded-full bg-compass-50 px-2 py-0.5 text-xs font-medium text-compass-700"
                    >
                      <Sparkles className="h-3 w-3" /> related
                    </span>
                  )}
                </div>
                <h3 className="font-semibold text-slate-900">{h.title}</h3>
                <p
                  className="mt-1 text-sm text-slate-500"
                  dangerouslySetInnerHTML={{ __html: safeSnippet(h.snippet) }}
                />
              </Link>
            ))}
            {!searching && hits.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-300 bg-surface p-8 text-center">
                <p className="font-medium text-slate-600">
                  No documents matched &ldquo;{submitted}&rdquo;.
                </p>
                <ul className="mx-auto mt-3 max-w-md space-y-1 text-left text-sm text-slate-500">
                  <li>· Try fewer or more general words — search also matches by meaning.</li>
                  {parseSearchQuery(submitted).hasFilters && (
                    <li>· Remove a filter chip above — operators narrow results.</li>
                  )}
                  <li>
                    · Narrow with operators:{" "}
                    <code className="rounded-sm bg-slate-100 px-1 font-mono text-xs">type:sop</code>{" "}
                    <code className="rounded-sm bg-slate-100 px-1 font-mono text-xs">tag:release</code>{" "}
                    <code className="rounded-sm bg-slate-100 px-1 font-mono text-xs">space:engineering</code>{" "}
                    <code className="rounded-sm bg-slate-100 px-1 font-mono text-xs">author:&quot;maya&quot;</code>
                  </li>
                  <li>· The ✨ answer above may still help — it reads across all your docs.</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-compass-300 border-t-compass-600" />
  );
}

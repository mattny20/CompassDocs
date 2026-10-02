"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Spinner } from "./Spinner";
import { chipClass } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import Link from "next/link";
import { Clock, Flame, Lightbulb, SearchX, Sparkles, X } from "lucide-react";
import { EmptyState, TextInput } from "./form";
import { MarkdownView } from "./MarkdownView";
import { PageContainer } from "./PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { TypeBadge } from "./Badges";
import { timeAgo } from "@/lib/ui";
import { askLabel } from "@/lib/nav-items";
import { parseSearchQuery } from "@/lib/search-query";
import type { DocType, SearchHit } from "@/lib/types";
import type { AiAnswer } from "@/lib/ai";
import { safeSnippet } from "@/lib/snippet";

const RECENT_KEY = "cd:ask-recent";
const RECENT_MAX = 6;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* private mode */
  }
}

/** Starters for an empty page: what the knowledge base tends to be asked. */
const SUGGESTED = [
  "How do I roll back a bad deploy?",
  "What is the escalation path for an outage?",
  "Where is the onboarding checklist?",
  "What is our expense policy?",
];

const OPERATORS: { op: string; hint: string }[] = [
  { op: "type:", hint: "sop, policy, technical, knowledge" },
  { op: "tag:", hint: "a tag, e.g. tag:release" },
  { op: "space:", hint: "a space slug, e.g. space:engineering" },
  { op: "author:", hint: 'a name, e.g. author:"Maya Chen"' },
];

export interface PopularDoc {
  id: number;
  title: string;
  type: DocType;
  space_name: string;
  space_icon?: string;
}

export function SearchClient({
  initialQuery,
  companyName = "CompassDocs",
  popular = [],
  spaceSlugs = [],
}: {
  initialQuery: string;
  companyName?: string;
  /** Most-read documents in the viewer's scope — the first-run state. */
  popular?: PopularDoc[];
  /** A few space slugs the viewer can narrow to, for the operator hint. */
  spaceSlugs?: string[];
}) {
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  // This browser's own recent questions (never sent anywhere).
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRecent(readRecent()), []);
  function remember(q: string) {
    const next = [q, ...readRecent().filter((r) => r !== q)].slice(0, RECENT_MAX);
    writeRecent(next);
    setRecent(next);
  }
  /** Put an operator at the caret (or append) and keep typing there. */
  function insertOperator(op: string) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? query.length;
    const end = el?.selectionEnd ?? start;
    const before = query.slice(0, start);
    const after = query.slice(end);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${op}${after}`;
    setQuery(next);
    const caret = before.length + pad.length + op.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }
  function ask(q: string) {
    setQuery(q);
    setSubmitted(q);
    remember(q);
    runSearch(q);
    runAsk(q);
    window.history.replaceState(null, "", `/search?q=${encodeURIComponent(q)}`);
  }
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
    if (!q) return;
    ask(q);
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Sparkles />}
        title={askLabel(companyName)}
        subtitle="Ask a question in plain English, or search by keyword. Answers are grounded in your knowledge base."
        className="mb-5"
      />

      <form onSubmit={onSubmit} className="mb-6 flex gap-2">
        <TextInput
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          aria-label="Ask a question or search by keyword"
          placeholder="e.g. How do I roll back a bad deploy?"
          className="flex-1 px-4 py-2.5 text-base"
        />
        <button
          type="submit"
          className={buttonClass("primary", "lg")}
        >
          Ask
        </button>
      </form>

      {/* First-run state (1.9.3): before a query the page used to be a title,
          one input and up to 1,800px of empty canvas. */}
      {!submitted && (
        <div className="grid gap-6 @container lg:grid-cols-2">
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <Lightbulb className="h-3.5 w-3.5" aria-hidden /> Try asking
            </h2>
            <ul className="space-y-1.5">
              {SUGGESTED.map((q) => (
                <li key={q}>
                  <button
                    type="button"
                    onClick={() => ask(q)}
                    className="w-full rounded-lg border border-slate-200 bg-surface px-3 py-2 text-left text-sm text-slate-700 transition hover:border-compass-300 hover:text-compass-700"
                  >
                    {q}
                  </button>
                </li>
              ))}
            </ul>
            <h2 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-slate-500">Narrow with an operator</h2>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Search operators">
              {OPERATORS.map((o) => (
                <button
                  key={o.op}
                  type="button"
                  onClick={() => insertOperator(o.op)}
                  data-tt={o.op === "space:" && spaceSlugs.length ? `a space, e.g. space:${spaceSlugs[0]}` : o.hint}
                  className="rounded-full border border-slate-200 bg-surface px-2.5 py-0.5 font-mono text-xs text-slate-700 hover:border-compass-300 hover:text-compass-700"
                >
                  {o.op}
                </button>
              ))}
            </div>
            {recent.length > 0 && (
              <>
                <h2 className="mb-2 mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden /> Your recent searches
                  <button
                    type="button"
                    onClick={() => {
                      writeRecent([]);
                      setRecent([]);
                    }}
                    className="ml-auto font-medium normal-case tracking-normal text-slate-500 hover:text-slate-700"
                  >
                    Clear
                  </button>
                </h2>
                <ul className="flex flex-wrap gap-1.5">
                  {recent.map((r) => (
                    <li key={r}>
                      <button
                        type="button"
                        onClick={() => ask(r)}
                        className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-700 hover:bg-compass-50 hover:text-compass-700"
                      >
                        {r}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {popular.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
                <Flame className="h-3.5 w-3.5" aria-hidden /> Most read this month
              </h2>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-surface shadow-xs">
                {popular.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/doc/${d.id}`}
                      className="group flex items-center gap-3 px-3 py-2.5 transition first:rounded-t-xl last:rounded-b-xl hover:bg-slate-50"
                    >
                      <span className="text-base" aria-hidden>
                        {d.space_icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800 group-hover:text-compass-700">{d.title}</span>
                        <span className="block truncate text-xs text-slate-500">{d.space_name}</span>
                      </span>
                      <TypeBadge type={d.type} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

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
            <Sparkles className="h-4 w-4" aria-hidden /> Answer
            {answer?.mode === "fallback" && (
              <span className={chipClass("neutral")}>
                keyword mode
              </span>
            )}
          </div>
          {asking ? (
            <div className="flex items-center gap-2 py-3 text-slate-500">
              <Spinner /> Thinking through your documents…
            </div>
          ) : (
            answer && (
              <>
                <MarkdownView content={answer.answer} />
                {(answer.people?.length ?? 0) > 0 && (
                  <div className="mt-4 border-t border-compass-100 pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
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
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
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
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            {searching ? "Searching…" : `${hits.length} matching document${hits.length === 1 ? "" : "s"}`}
          </h2>
          {/* The house grid (1.9.3): one column at Normal, two at Wide, three
              at 2560 Full, instead of one 2,000px card per hit. */}
          <div className="card-grid gap-3 [--card-min:22rem]">
            {hits.map((h) => (
              <Link
                key={h.id}
                href={`/doc/${h.id}`}
                className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-xs transition hover:border-compass-300 hover:shadow-md"
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
                      data-tt="Found by meaning, not keywords"
                      aria-label="Related: found by meaning, not keywords"
                      className={chipClass("accent")}
                    >
                      <Sparkles className="h-3 w-3" aria-hidden /> related
                    </span>
                  )}
                </div>
                <h3 className="line-clamp-2 font-semibold text-slate-900">{h.title}</h3>
                <p
                  className="mt-1 line-clamp-2 text-sm text-slate-500"
                  dangerouslySetInnerHTML={{ __html: safeSnippet(h.snippet) }}
                />
              </Link>
            ))}
            {!searching && hits.length === 0 && (
              <div className="col-span-full">
              <EmptyState
                icon={<SearchX />}
                title={<>No documents matched &ldquo;{submitted}&rdquo;</>}
              >
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
                  <li>· The answer above may still help — it reads across all your documents.</li>
                </ul>
              </EmptyState>
              </div>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}


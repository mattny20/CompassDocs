"use client";

// The help centre's search (Helpdesk 1.19.4, C3, mock h1): one box,
// suggestions as you type in a card right under it (not a floating panel:
// the hero grows to hold them, as in the mock), each a link with a
// BookOpen glyph. Arrows walk the box and the suggestions; Enter in the
// box opens the results page (/support/search, a plain GET form, so it
// works without script too). The suggestions come from
// /support/api/help/search, which only ever answers public articles. A
// rate-limited answer shows the server's "Too many searches" sentence over
// the last suggestions, never "No articles match".

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, Search } from "lucide-react";
import { SectionEmpty, TextInput } from "@/components/form";
import { journeyId, journeyStep } from "./journey";
import type { HelpSuggestion } from "@/lib/helpdesk/help-centre-shared";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 220;

export function HelpSearch({ initial = "", autoFocus = false, wide = false, className = "" }: { initial?: string; autoFocus?: boolean; wide?: boolean; className?: string }) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HelpSuggestion[] | null>(null);
  // The server's sentence when searching is rate-limited (never "no match").
  const [limited, setLimited] = useState("");
  const [journey, setJourney] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const query = q.trim();

  useEffect(() => {
    setJourney(journeyId());
  }, []);

  useEffect(() => {
    if (!open || query.length < MIN_QUERY) {
      setItems(null);
      setLimited("");
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const j = journeyId(true);
      setJourney(j);
      try {
        const res = await fetch(`/support/api/help/search?q=${encodeURIComponent(query)}&j=${encodeURIComponent(j)}`, {
          signal: ctl.signal,
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        const data = (await res.json().catch(() => ({}))) as { articles?: HelpSuggestion[]; error?: string };
        if (ctl.signal.aborted) return;
        if (res.status === 429) {
          setLimited(data.error || "Too many searches right now. Wait a moment and try again.");
          setItems((cur) => cur ?? []);
          return;
        }
        setLimited("");
        setItems(res.ok ? (data.articles ?? []) : []);
      } catch {
        if (!ctl.signal.aborted) setItems((cur) => cur ?? []);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, open]);

  const show = open && query.length >= MIN_QUERY && items !== null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && show) {
      setOpen(false);
      input.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = Array.from(list.current?.querySelectorAll<HTMLElement>("a[href]") ?? []);
    if (!links.length) return;
    const i = links.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    if (e.key === "ArrowDown") links[i < 0 ? 0 : Math.min(i + 1, links.length - 1)].focus();
    else if (i <= 0) input.current?.focus();
    else links[i - 1].focus();
  }

  return (
    <form action="/support/search" method="get" role="search" className={`mx-auto w-full text-left ${wide ? "" : "max-w-xl"} ${className}`.replace(/\s+/g, " ").trim()} onKeyDown={onKeyDown}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-500" aria-hidden />
        <TextInput
          ref={input}
          type="search"
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          maxLength={120}
          placeholder="Search the help centre"
          aria-label="Search the help centre"
          aria-expanded={show}
          aria-controls={show ? listId : undefined}
          autoComplete="off"
          enterKeyHint="search"
          className="h-12 rounded-xl pl-11 pr-4 text-base shadow-xs sm:text-[0.95rem]"
        />
        {journey && <input type="hidden" name="j" value={journey} />}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {show ? (limited ? limited : items!.length === 0 ? "No articles match that yet." : items!.length === 1 ? "1 suggested article." : `${items!.length} suggested articles.`) : ""}
      </p>
      {show && (
        <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" data-testid="help-suggestions">
          {limited && (
            <p className="notice-warn border-b px-4 py-2.5 text-sm" data-testid="help-limited">
              {limited}
            </p>
          )}
          {items!.length === 0 ? (
            limited ? null : <SectionEmpty className="px-4 py-3">No articles match that yet. Try other words, or raise a request.</SectionEmpty>
          ) : (
            <ul ref={list} id={listId} aria-label="Suggested articles">
              {items!.map((a) => (
                <li key={a.id} className="border-b border-slate-100 last:border-b-0">
                  <Link
                    href={a.href}
                    onClick={() => journeyStep("open")}
                    className="flex items-center gap-2.5 px-4 py-2.5 text-[0.95rem] text-slate-900 transition hover:bg-slate-50 focus-visible:bg-slate-50"
                  >
                    <BookOpen className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                    <span className="min-w-0 truncate">{a.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

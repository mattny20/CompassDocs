"use client";

// The Get help search (1.19.0, the approved round-1 preview): one box that
// suggests documents from the person's own spaces before anyone opens a
// request ("These might solve it"), with "Still stuck? Send a request"
// under the suggestions so the way on is never more than one click. The
// suggestions come from /api/helpdesk/suggest, which searches with the
// person's space scope and the handbook-only find scope, so it never
// suggests a document they could not open.

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, Plus, Search } from "lucide-react";
import { Popover } from "@/components/Popover";
import { Button } from "@/components/Button";
import { SectionEmpty, TextInput } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import { EYEBROW_TEXT } from "@/components/Heading";
import type { HdSuggestedArticle } from "@/lib/helpdesk/types";
import { fetchJson } from "./shared";

const MIN_QUERY = 3;
const DEBOUNCE_MS = 250;

export function KbSearch({ className = "" }: { className?: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [articles, setArticles] = useState<HdSuggestedArticle[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const query = q.trim();

  useEffect(() => {
    if (query.length < MIN_QUERY) {
      setArticles(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await fetchJson<{ articles?: HdSuggestedArticle[] } | HdSuggestedArticle[]>(
        `/api/helpdesk/suggest?q=${encodeURIComponent(query)}`,
        { signal: ctl.signal },
        "Couldn't search the guides."
      );
      if (ctl.signal.aborted) return;
      setBusy(false);
      // A failed search still offers the request: the panel shows "Still stuck?" alone.
      setArticles(res.ok ? (Array.isArray(res.data) ? res.data : (res.data.articles ?? [])) : []);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query]);

  const showPanel = open && query.length >= MIN_QUERY;
  const newHref = `/help/new?subject=${encodeURIComponent(query)}`;

  /** Arrows walk the box and the suggestions; Escape is the Popover's. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>("a[href]") ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    if (e.key === "ArrowDown") items[i < 0 ? 0 : Math.min(i + 1, items.length - 1)].focus();
    else if (i <= 0) input.current?.focus();
    else items[i - 1].focus();
  }

  return (
    <div className={`relative max-w-2xl ${className}`.trim()} onKeyDown={onKeyDown}>
      <Search className="pointer-events-none absolute left-3.5 top-5.5 -translate-y-1/2 h-4.5 w-4.5 text-slate-400" aria-hidden />
      <TextInput
        ref={input}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        maxLength={200}
        placeholder="Describe what you need…"
        aria-label="Describe what you need"
        aria-expanded={showPanel}
        aria-controls={showPanel ? panelId : undefined}
        aria-haspopup="dialog"
        autoComplete="off"
        className="h-11 pl-11 pr-3 text-base sm:text-sm print:hidden"
      />
      <div ref={panel} id={panelId}>
        <Popover
          open={showPanel}
          onClose={() => setOpen(false)}
          triggerRef={input}
          label="Suggested guides"
          width="w-full"
          padding="p-1.5"
        >
          <p className={`${EYEBROW_TEXT} px-2 pb-1 pt-1.5`}>These might solve it</p>
          <div aria-live="polite" aria-busy={busy || undefined}>
            {articles === null ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-slate-500">
                <Spinner size="sm" /> Searching the guides…
              </div>
            ) : articles.length === 0 ? (
              <SectionEmpty className="px-2 py-3">No guides match that yet.</SectionEmpty>
            ) : (
              <ul>
                {articles.slice(0, 5).map((a) => (
                  <li key={a.doc_id}>
                    <Link
                      href={a.url || `/doc/${a.doc_id}`}
                      className="flex items-start gap-2.5 rounded-md px-2 py-2 transition hover:bg-slate-50 focus-visible:bg-slate-50"
                    >
                      <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">{a.title}</span>
                        <span className="block truncate text-xs text-slate-500">
                          {[a.space_name, a.read_minutes ? `${a.read_minutes} min read` : ""].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-2 pb-1 pt-2">
            <span className="text-sm text-slate-500">Still stuck?</span>
            <Button href={newHref} size="sm" icon={<Plus />}>
              Send a request
            </Button>
          </div>
        </Popover>
      </div>
    </div>
  );
}

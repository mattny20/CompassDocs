"use client";

// The composer's article picker: the ticket's suggestions from your
// CompassDocs documents first, then whatever you search for (GET
// /api/helpdesk/suggest?q=, the same scope-aware search Get help uses).
// Picking one writes a Markdown link into the reply.

import { useEffect, useRef, useState, type RefObject } from "react";
import { BookOpen } from "lucide-react";
import { Popover } from "@/components/Popover";
import { Spinner } from "@/components/Spinner";
import { SectionEmpty, controlClass } from "@/components/form";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";
import type { HdSuggestedArticle } from "@/lib/helpdesk/types";
import { getJson, listOf } from "../api";

export function ArticlePicker({
  open,
  onClose,
  triggerRef,
  suggestions,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  suggestions: HdSuggestedArticle[];
  onPick: (a: HdSuggestedArticle) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HdSuggestedArticle[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setHits(null);
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setHits(null);
      return;
    }
    setBusy(true);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      getJson(`/api/helpdesk/suggest?q=${encodeURIComponent(t)}`, "", ac.signal)
        .then((d) => setHits(listOf<HdSuggestedArticle>(d, "articles", "suggestions")))
        .catch(() => !ac.signal.aborted && setHits([]))
        .finally(() => !ac.signal.aborted && setBusy(false));
    }, 200);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [q]);

  const list = hits ?? suggestions;
  const heading = hits ? "Search results" : "Suggested from your documents";

  return (
    <Popover open={open} onClose={onClose} triggerRef={triggerRef} role="dialog" label="Insert an article" side="top" width="w-[min(24rem,calc(100vw-2rem))]" padding="p-2">
      <input
        ref={input}
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && list[active]) {
            e.preventDefault();
            onPick(list[active]);
          }
        }}
        role="combobox"
        aria-expanded
        aria-controls="desk-article-list"
        aria-activedescendant={list[active] ? `desk-article-${list[active].doc_id}` : undefined}
        aria-label="Search your documents"
        placeholder="Search your documents…"
        className={controlClass(false, "", true)}
      />
      <p className={`${RAIL_GROUP_TEXT} mt-2 flex items-center gap-2 px-2`}>
        {heading}
        {busy && <Spinner size="sm" />}
      </p>
      <div id="desk-article-list" role="listbox" aria-label={heading} className="mt-1 max-h-72 overflow-y-auto">
        {list.length === 0 && !busy && (
          <SectionEmpty className="px-2 py-3">{hits ? "No documents match." : "Search for a document to link in your reply."}</SectionEmpty>
        )}
        {list.map((a, i) => (
          <div
            key={a.doc_id}
            id={`desk-article-${a.doc_id}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(a)}
            className={`flex cursor-pointer gap-2 rounded-md px-2 py-1.5 ${i === active ? "bg-compass-50" : ""}`}
          >
            <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-900">{a.title}</span>
              <span className="block truncate text-xs text-slate-500">
                {a.space_name}
                {a.read_minutes ? ` · ${a.read_minutes} min read` : ""}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Popover>
  );
}

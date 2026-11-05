"use client";

// The handbook reader's contents rail (1.18.0): the reader's progress (with
// read confirmation licensed and at least one policy asking them), then
// every section with its numbered policies, a tick on each one the reader
// has confirmed, and, nested under the policy on screen, that policy's own
// headings, marked as they are read. A sticky card beside the policy from
// lg; above it, collapsed behind one "Contents" button, on a phone, so the
// policy is the first thing a small screen shows.
//
// The headings come from the rendered body (article.doc-read), as DocToc
// reads them on the document page; DocToc itself is not mounted here, so
// this rail assigns the ids (the same slug rule) and lands a #heading deep
// link once they exist. Policies are links (one URL each, so a policy can
// be bookmarked and shared); the one on screen carries aria-current="page"
// and a heading being read aria-current="location".

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, TableOfContents } from "lucide-react";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";
import { CARD_CLASS } from "@/components/Card";

export interface ContentsItem {
  docId: number;
  number: number;
  title: string;
  href: string;
  /** The reader holds a confirmation that counts for this policy. */
  confirmed: boolean;
}

export interface ContentsSection {
  id: number;
  number: number;
  title: string;
  items: ContentsItem[];
}

interface Heading {
  id: string;
  text: string;
  level: number;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "section"
  );
}

/** Clear of the page top; the offset headings scroll to. */
const TOP_OFFSET_PX = 96;

/** The policy body's headings (the two shallowest levels present), with ids, and the one being read. */
function usePolicyHeadings(key: number | null): { items: Heading[]; active: string } {
  const [items, setItems] = useState<Heading[]>([]);
  const [active, setActive] = useState("");
  const landed = useRef(false);

  useEffect(() => {
    const article = document.querySelector("article.doc-read");
    if (!article || key === null) {
      setItems([]);
      return;
    }
    const seen = new Map<string, number>();
    const found: Heading[] = [];
    // Every level: the body's headings are shifted under the policy's h2
    // (MarkdownView headingOffset, an authored h1 is an h3 here), and the
    // rail keeps the two shallowest present whatever their tags.
    article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const text = (h.textContent || "").trim();
      if (!text) return;
      if (!h.id) {
        const base = slugify(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        h.id = n === 0 ? base : `${base}-${n + 1}`;
      }
      h.style.scrollMarginTop = "5rem";
      found.push({ id: h.id, text, level: Number(h.tagName[1]) });
    });
    const top = Math.min(...found.map((f) => f.level));
    setItems(found.filter((f) => f.level <= top + 1));

    if (!landed.current && window.location.hash.length > 1) {
      landed.current = true;
      let id = "";
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        id = window.location.hash.slice(1);
      }
      document.getElementById(id)?.scrollIntoView();
    }
  }, [key]);

  // The last heading whose top has passed the offset; the last one once the
  // end of the body is on screen (a short closing section never gets there).
  useEffect(() => {
    if (items.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = "";
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= TOP_OFFSET_PX) current = it.id;
        else break;
      }
      const article = document.querySelector("article.doc-read");
      if (current && article && article.getBoundingClientRect().bottom <= window.innerHeight) {
        current = items[items.length - 1].id;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    // The app shell scrolls #main, not the window: listen in the capture phase.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  return { items, active };
}

export function HandbookContents({
  sections,
  activeDocId,
  introHref,
  introActive,
  hasIntroduction,
  inShortId,
  progress,
}: {
  sections: ContentsSection[];
  /** The policy on screen; null on the introduction. */
  activeDocId: number | null;
  introHref: string;
  /** The introduction is on screen. */
  introActive: boolean;
  hasIntroduction: boolean;
  /** The "In short" anchor of the policy on screen, when it has summary points. */
  inShortId: string | null;
  /** Policies that ask this reader to confirm, and how many they have; null hides the bar. */
  progress: { confirmed: number; total: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { items: headings, active } = usePolicyHeadings(activeDocId);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const activeItem = sections.flatMap((s) => s.items).find((i) => i.docId === activeDocId) ?? null;
  const pct = progress && progress.total > 0 ? Math.round((progress.confirmed / progress.total) * 100) : 0;

  // A phone closes the panel after a jump, so the policy is what it shows.
  const close = () => setOpen(false);

  return (
    <nav aria-label="Handbook contents" className={`${CARD_CLASS} px-2 py-3 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto print:hidden`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm font-medium text-slate-700 lg:hidden"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <TableOfContents className="h-4 w-4 text-slate-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Contents
          {activeItem ? ` · Policy ${activeItem.number} of ${total}` : ""}
          {progress ? ` · ${progress.confirmed} of ${progress.total} confirmed` : ""}
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      <div id={listId} className={`${open ? "mt-2 block" : "hidden"} lg:mt-0 lg:block`}>
        {progress && progress.total > 0 && (
          <div className="px-2 pb-2">
            <div className={RAIL_GROUP_TEXT}>Your progress</div>
            <div className="mt-1.5 flex justify-between text-sm text-slate-700">
              <span>
                {progress.confirmed} of {progress.total} confirmed
              </span>
              <span>{pct}%</span>
            </div>
            <div
              className="mt-1.5 h-1.5 rounded-full bg-slate-100"
              role="progressbar"
              aria-label="Policies confirmed"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.confirmed}
              aria-valuetext={`${progress.confirmed} of ${progress.total} confirmed`}
            >
              <div className="h-1.5 rounded-full bg-compass-600" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {hasIntroduction && (
          <Link
            href={introHref}
            onClick={close}
            aria-current={introActive ? "page" : undefined}
            className={`mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
              introActive
                ? "bg-compass-50 font-semibold text-compass-700"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
            }`}
          >
            <span className="w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Introduction</span>
          </Link>
        )}

        {sections.map((s) => (
          <div key={s.id}>
            {/* A group label, not a heading: the policy's title is the
                page's h2, and the rail should not compete in the outline. */}
            {s.title && (
              <div id={`${listId}-s${s.id}`} className={`${RAIL_GROUP_TEXT} px-2 pb-1 pt-3`}>
                {s.number} · {s.title}
              </div>
            )}
            <ol className={s.title ? "" : "pt-2"} aria-labelledby={s.title ? `${listId}-s${s.id}` : undefined}>
              {s.items.map((it) => {
                const on = it.docId === activeDocId;
                return (
                  <li key={it.docId}>
                    <Link
                      href={it.href}
                      onClick={close}
                      aria-current={on ? "page" : undefined}
                      className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                        on ? "bg-compass-50 font-semibold text-compass-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                      }`}
                    >
                      <span className="w-4 shrink-0 font-normal tabular-nums text-slate-500">{it.number}</span>
                      <span className="min-w-0 flex-1">{it.title}</span>
                      {it.confirmed && (
                        <>
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          <span className="sr-only">(confirmed)</span>
                        </>
                      )}
                    </Link>
                    {on && (inShortId || headings.length > 0) && (
                      <ol aria-label="On this policy" className="mb-1 mt-0.5">
                        {inShortId && (
                          <li>
                            <a
                              href={`#${inShortId}`}
                              onClick={close}
                              className="block py-0.5 pl-10 pr-2 text-xs text-slate-500 hover:text-compass-700"
                            >
                              In short
                            </a>
                          </li>
                        )}
                        {headings.map((h) => {
                          const cur = h.id === active;
                          const indent = h.level > Math.min(...headings.map((x) => x.level)) ? "pl-13" : "pl-10";
                          return (
                            <li key={h.id}>
                              <a
                                href={`#${h.id}`}
                                onClick={close}
                                aria-current={cur ? "location" : undefined}
                                className={`block py-0.5 pr-2 text-xs transition ${indent} ${
                                  cur
                                    ? "font-semibold text-compass-700 shadow-[inset_2px_0_0_rgb(var(--compass-600))]"
                                    : "text-slate-500 hover:text-compass-700"
                                }`}
                              >
                                {h.text}
                              </a>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </nav>
  );
}

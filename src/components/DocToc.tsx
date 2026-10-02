"use client";

// Table of contents for a document page, built from the rendered H1–H3
// headings. Ids are assigned here (the markdown pipeline doesn't emit them),
// so a deep link to a heading is also landed here, once the ids exist.
// Hidden entirely for docs with fewer than two listed headings.
//
// Two placements (1.9.0), chosen by DocLayout through context:
//   "card" — a collapsible card above the body, open by default and
//            remembered per browser like the other doc panels. Narrow
//            screens and the Normal width, where there is no rail.
//   "rail" — rail furniture at Wide and Full: a section like Related
//            documents, capped at half the viewport with its own scroll.
// Both mark the heading you are reading as you scroll (aria-current).

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { chipClass } from "@/components/Chip";
import { ChevronRight, TableOfContents } from "lucide-react";
import { usePanelCollapse } from "@/lib/use-panel-collapse";

interface Item {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export type TocPlacement = "card" | "rail";
export const TocPlacementContext = createContext<TocPlacement>("card");

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

/** Loose match so "Production Deployment SOP" == "# Production Deployment SOP". */
function sameHeading(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Clear of the sticky doc bar; the same offset the headings scroll to. */
const TOP_OFFSET_PX = 96;

/** The headings of the page's article, with ids, plus the one in view. */
function useHeadings(title?: string): { items: Item[]; active: string } {
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState("");
  const landed = useRef(false);

  useEffect(() => {
    const article = document.querySelector("article");
    if (!article) return;
    const seen = new Map<string, number>();
    const found: Item[] = [];
    article.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((h) => {
      const text = (h.textContent || "").trim();
      if (!text) return;
      if (!h.id) {
        const base = slugify(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        h.id = n === 0 ? base : `${base}-${n + 1}`;
      }
      // Keep jumps clear of the sticky doc bar.
      h.style.scrollMarginTop = "5rem";
      found.push({ id: h.id, text, level: Number(h.tagName[1]) as 1 | 2 | 3 });
    });
    // Most documents open with `# Title` repeating the title already shown in
    // the masthead. Drop that leading duplicate from the outline — but only
    // that one, and only when it really is the title, so documents that use
    // H1s as real sections keep them. The heading still gets its id above, so
    // existing #anchor links keep working.
    const listed =
      found[0]?.level === 1 && title && sameHeading(found[0].text, title) ? found.slice(1) : found;
    setItems(listed);

    // A deep link arrived before the ids existed, so the browser could not
    // land it. Now it can — once, and never after the person has scrolled.
    if (!landed.current && window.location.hash.length > 1) {
      landed.current = true;
      let id = "";
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        id = window.location.hash.slice(1);
      }
      const target = found.find((f) => f.id === id);
      if (target) document.getElementById(target.id)?.scrollIntoView();
    }
  }, [title]);

  // The current heading: the last one whose top has passed the sticky bar.
  // A scroll listener rather than an IntersectionObserver because "last
  // passed" is a question about order, which the observer cannot answer on
  // its own for headings that have scrolled far above the viewport.
  useEffect(() => {
    if (items.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = items[0].id;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= TOP_OFFSET_PX) current = it.id;
        else break;
      }
      // When the end of the article is on screen the last heading may never
      // reach the bar (a short closing section cannot scroll that far), but
      // it is what the person is reading.
      const article = document.querySelector("article");
      if (article && article.getBoundingClientRect().bottom <= window.innerHeight) {
        current = items[items.length - 1].id;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    // The app shell scrolls `#main`, not the window, so listen in the
    // capture phase on the document: every scroll container reports there.
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

export function DocToc({ title }: { title?: string }) {
  const placement = useContext(TocPlacementContext);
  const { items, active } = useHeadings(title);
  // Remembered per browser, like the Attachments / Related-documents panels.
  const [open, toggleOpen] = usePanelCollapse("toc", true);

  if (items.length < 2) return null;

  const list = (
    <ol className={placement === "rail" ? "max-h-[50vh] overflow-y-auto border-l border-slate-200" : "border-t border-slate-100 px-4 py-2.5"}>
      {items.map((it, i) => {
        const current = it.id === active;
        return (
          <li key={`${it.id}-${i}`} style={{ paddingLeft: `${(it.level - 1) * (placement === "rail" ? 0.75 : 1.1)}rem` }}>
            <a
              href={`#${it.id}`}
              aria-current={current ? "location" : undefined}
              className={
                placement === "rail"
                  ? `-ml-px block truncate border-l-2 py-1 pl-3 pr-1 text-sm ${
                      current
                        ? "border-compass-500 font-medium text-compass-700"
                        : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
                    }`
                  : `block truncate rounded-sm px-1.5 py-1 text-sm ${
                      current
                        ? "bg-compass-50 font-medium text-compass-700"
                        : "text-slate-600 hover:bg-slate-50 hover:text-compass-700"
                    }`
              }
            >
              {it.text}
            </a>
          </li>
        );
      })}
    </ol>
  );

  if (placement === "rail") {
    return (
      <nav aria-label="Table of contents">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700"
        >
          <TableOfContents className="h-3.5 w-3.5" aria-hidden />
          On this page
          <span className={chipClass("neutral", "sm")}>{items.length}</span>
          <ChevronRight
            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
        </button>
        {open && <div className="mt-2">{list}</div>}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Table of contents"
      // Hugs the reading measure (inherited from the page-width container)
      // instead of spanning a 2,000px column above an 800px text block.
      className="mb-5 max-w-[var(--doc-measure,none)] rounded-xl border border-slate-200 bg-surface"
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-800"
      >
        <TableOfContents className="h-4 w-4 text-slate-400" aria-hidden />
        Table of contents
        <span className={chipClass("neutral")}>{items.length}</span>
        <ChevronRight
          className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
      </button>
      {open && list}
    </nav>
  );
}

"use client";

// Table of contents for a document page, built from the rendered H1–H3
// headings. Open by default and remembered per browser like the other doc
// panels; expanding shows an indented outline whose links jump to the heading
// (ids are assigned here — the markdown pipeline doesn't emit them). Hidden
// entirely for docs with fewer than two listed headings.

import { useEffect, useState } from "react";
import { ChevronRight, TableOfContents } from "lucide-react";
import { usePanelCollapse } from "@/lib/use-panel-collapse";

interface Item {
  id: string;
  text: string;
  level: 1 | 2 | 3;
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

/** Loose match so "Production Deployment SOP" == "# Production Deployment SOP". */
function sameHeading(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

export function DocToc({ title }: { title?: string }) {
  const [items, setItems] = useState<Item[]>([]);
  // Remembered per browser, like the Attachments / Related-documents panels.
  const [open, toggleOpen] = usePanelCollapse("toc", true);

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
  }, [title]);

  if (items.length < 2) return null;

  return (
    <nav
      aria-label="Table of contents"
      className="mb-5 rounded-xl border border-slate-200 bg-surface"
    >
      <button
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-800"
      >
        <TableOfContents className="h-4 w-4 text-slate-400" aria-hidden />
        Table of contents
        <span className="rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-500">
          {items.length}
        </span>
        <ChevronRight
          className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="border-t border-slate-100 px-4 py-2.5">
          {items.map((it, i) => (
            <li key={`${it.id}-${i}`} style={{ paddingLeft: `${(it.level - 1) * 1.1}rem` }}>
              <a
                href={`#${it.id}`}
                className="block truncate rounded-sm px-1.5 py-1 text-sm text-slate-600 hover:bg-slate-50 hover:text-compass-700"
              >
                {it.text}
              </a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}

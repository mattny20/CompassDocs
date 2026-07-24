"use client";

// Table of contents for a document page, built from the rendered H1–H3
// headings. Collapsed by default; expanding shows an indented outline whose
// links jump to the heading (ids are assigned here — the markdown pipeline
// doesn't emit them). Hidden entirely for docs with fewer than two headings.

import { useEffect, useState } from "react";
import { ChevronRight, TableOfContents } from "lucide-react";

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

export function DocToc() {
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);

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
    setItems(found);
  }, []);

  if (items.length < 2) return null;

  return (
    <nav
      aria-label="Table of contents"
      className="mb-5 rounded-xl border border-slate-200 bg-surface"
    >
      <button
        onClick={() => setOpen((o) => !o)}
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
                className="block truncate rounded px-1.5 py-1 text-sm text-slate-600 hover:bg-slate-50 hover:text-compass-700"
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

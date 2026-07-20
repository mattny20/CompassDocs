"use client";

// [[ link autocomplete for the rich editor (backlinks feature, admin-gated).
// Typing "[[query" opens a floating searchable list of documents at the
// caret; picking one replaces the trigger text with a proper internal link
// ([Title](/doc/id)), which is what the backlinks extractor indexes.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { FileText } from "lucide-react";

interface Hit {
  id: number;
  title: string;
  status: string;
  space_name: string;
  space_icon: string;
}

interface ActiveState {
  from: number; // doc position of the first "["
  query: string;
  x: number;
  y: number;
}

export function DocLinkSuggest({ editor }: { editor: Editor }) {
  const [active, setActive] = useState<ActiveState | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Detect "[[query" immediately before a collapsed caret.
  useEffect(() => {
    const check = () => {
      const { state } = editor;
      const { from, empty } = state.selection;
      if (!empty || !editor.isFocused) {
        setActive(null);
        return;
      }
      const start = Math.max(0, from - 80);
      const text = state.doc.textBetween(start, from, "\n", "￼");
      const m = /\[\[([^[\]\n]{0,60})$/.exec(text);
      if (!m) {
        setActive(null);
        return;
      }
      const coords = editor.view.coordsAtPos(from);
      setActive({ from: from - m[0].length, query: m[1], x: coords.left, y: coords.bottom });
    };
    editor.on("update", check);
    editor.on("selectionUpdate", check);
    editor.on("blur", check);
    return () => {
      editor.off("update", check);
      editor.off("selectionUpdate", check);
      editor.off("blur", check);
    };
  }, [editor]);

  // Debounced title lookup while the trigger is open.
  const query = active?.query;
  useEffect(() => {
    if (query === undefined) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/documents/lookup?q=${encodeURIComponent(query)}&limit=8`);
        if (res.ok) {
          setHits((await res.json()).docs);
          setSel(0);
        }
      } catch {
        /* lookup is best-effort */
      }
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const pick = useCallback(
    (hit: Hit) => {
      if (!active) return;
      const to = editor.state.selection.from;
      editor
        .chain()
        .focus()
        .deleteRange({ from: active.from, to })
        .insertContent([
          {
            type: "text",
            text: hit.title,
            marks: [{ type: "link", attrs: { href: `/doc/${hit.id}` } }],
          },
          { type: "text", text: " " }, // unlinked, so typing continues plain
        ])
        .run();
      setActive(null);
    },
    [active, editor]
  );

  // Capture-phase keys so the dropdown wins over ProseMirror while open.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSel((s) => Math.min(s + 1, Math.max(0, hits.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSel((s) => Math.max(0, s - 1));
      } else if ((e.key === "Enter" || e.key === "Tab") && hits[sel]) {
        e.preventDefault();
        e.stopPropagation();
        pick(hits[sel]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setActive(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active, hits, sel, pick]);

  if (!active) return null;
  const x = Math.min(active.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 340);

  return (
    <div
      className="fixed z-40 w-80 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-lg"
      style={{ left: Math.max(8, x), top: active.y + 6 }}
    >
      {hits.length === 0 ? (
        <p className="px-3 py-2 text-sm text-slate-400">
          {active.query ? "No matching documents." : "Type to search documents…"}
        </p>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                // preventDefault keeps the editor focused through the click
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(h);
                }}
                onMouseEnter={() => setSel(i)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  i === sel ? "bg-compass-50 text-compass-800" : "text-slate-700"
                }`}
              >
                <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{h.title}</span>
                  <span className="block truncate text-xs text-slate-400">
                    {h.space_icon} {h.space_name}
                    {h.status === "draft" ? " · draft" : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-slate-100 px-3 py-1 text-[11px] text-slate-400">
        ↑↓ to choose · Enter to link · Esc to dismiss
      </p>
    </div>
  );
}

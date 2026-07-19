"use client";

// Interactive rich-document blocks rendered from Markdown by MarkdownView:
// Mermaid + PlantUML diagrams, tab groups, decision trees, filterable tables,
// and persistent checklists. Presentation-only siblings (callouts, accordions,
// video/site embeds) live in DocBlocksStatic.tsx so they stay server-rendered.

import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RotateCcw, ArrowLeft, Search, ArrowUpDown } from "lucide-react";
import { parseDecisionTree } from "@/lib/doc-blocks";

function isDarkTheme(): boolean {
  const t = document.documentElement.getAttribute("data-theme");
  if (t) return t === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Re-render when the app theme toggles (data-theme on <html>). */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(isDarkTheme());
    const obs = new MutationObserver(() => setDark(isDarkTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// --- Mermaid ------------------------------------------------------------------

let mermaidSeq = 0;

export function MermaidBlock({ code }: { code: string }) {
  const dark = useDarkTheme();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(`cd-mermaid-${++mermaidSeq}`, code);
        if (alive) {
          setSvg(svg);
          setError("");
        }
      } catch (e: any) {
        if (alive) setError(e?.message || "Couldn't render this diagram.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, dark]);

  if (error) {
    return (
      <div className="my-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Mermaid:</strong> {error.split("\n")[0]}
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-400 dark:bg-slate-800/40">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="my-4 overflow-x-auto rounded-lg border border-slate-200 bg-surface p-4 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// --- PlantUML -----------------------------------------------------------------

export function PlantUmlBlock({ code }: { code: string }) {
  const dark = useDarkTheme();
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let url = "";
    (async () => {
      try {
        const res = await fetch("/api/plantuml", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, dark }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `Diagram server returned ${res.status}.`);
        }
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (alive) {
          setSrc(url);
          setError("");
        }
      } catch (e: any) {
        if (alive) setError(e?.message || "Couldn't render this diagram.");
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [code, dark]);

  if (error) {
    return (
      <div className="my-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>PlantUML:</strong> {error}
      </div>
    );
  }
  if (!src) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-400 dark:bg-slate-800/40">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Rendering diagram…
      </div>
    );
  }
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-center dark:bg-slate-900">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="PlantUML diagram" className="mx-auto max-w-full" />
    </div>
  );
}

// --- Tabs ---------------------------------------------------------------------

export function DocTabs({ titles, children }: { titles: string[]; children: React.ReactNode }) {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const panels = Array.from(root.querySelectorAll<HTMLElement>(":scope > .md-tab"));
    panels.forEach((p, i) => {
      p.style.display = i === active ? "" : "none";
    });
  }, [active, children]);

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-slate-200">
      <div className="flex flex-wrap gap-1 border-b border-slate-200 bg-slate-50 px-2 pt-2 dark:bg-slate-800/40">
        {titles.map((t, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={`rounded-t-md px-3 py-1.5 text-sm font-medium ${
              i === active
                ? "border border-b-0 border-slate-200 bg-surface text-compass-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
            style={i === active ? { marginBottom: -1 } : undefined}
          >
            {t}
          </button>
        ))}
      </div>
      <div ref={ref} className="px-4 py-1 [&>.md-tab>*:first-child]:mt-3 [&>.md-tab>*:last-child]:mb-3">
        {children}
      </div>
    </div>
  );
}

// --- Decision tree ------------------------------------------------------------

export function DecisionTreeBlock({ code }: { code: string }) {
  const tree = useMemo(() => parseDecisionTree(code), [code]);
  const [path, setPath] = useState<Array<{ node: string; choice: string }>>([]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const currentId = path.length ? undefined : tree.start;
  const nodeId = outcome !== null ? null : path.length === 0 ? tree.start : pathTarget();

  function pathTarget(): string {
    const last = path[path.length - 1];
    const node = tree.nodes[last.node];
    const choice = node?.choices.find((c) => c.label === last.choice);
    return choice?.next ?? tree.start;
  }

  if (tree.error) {
    return (
      <div className="my-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
        <strong>Decision tree:</strong> {tree.error}
      </div>
    );
  }
  const node = nodeId ? tree.nodes[nodeId] : null;

  function pick(choiceLabel: string) {
    if (!node) return;
    const choice = node.choices.find((c) => c.label === choiceLabel);
    if (!choice) return;
    setPath([...path, { node: node.id, choice: choiceLabel }]);
    if (choice.outcome !== null) setOutcome(choice.outcome);
  }
  function back() {
    if (outcome !== null) setOutcome(null);
    setPath(path.slice(0, -1));
  }
  function restart() {
    setOutcome(null);
    setPath([]);
  }

  return (
    <div className="my-4 rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-compass-600">
          Decision guide
        </span>
        <span className="flex gap-1">
          {(path.length > 0 || outcome !== null) && (
            <button
              onClick={back}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3 w-3" /> Back
            </button>
          )}
          {path.length > 0 && (
            <button
              onClick={restart}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50"
            >
              <RotateCcw className="h-3 w-3" /> Start over
            </button>
          )}
        </span>
      </div>

      {path.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-400">
          {path.map((p, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span>›</span>}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                {tree.nodes[p.node]?.question.replace(/\?$/, "")} → <strong>{p.choice}</strong>
              </span>
            </span>
          ))}
        </div>
      )}

      {outcome !== null ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800/60 dark:bg-emerald-950/40">
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
            Recommendation
          </div>
          <p className="mt-1 font-medium text-emerald-900 dark:text-emerald-100">{outcome}</p>
        </div>
      ) : node ? (
        <div>
          <p className="mb-3 font-semibold text-slate-800">{node.question}</p>
          <div className="flex flex-wrap gap-2">
            {node.choices.map((c) => (
              <button
                key={c.label}
                onClick={() => pick(c.label)}
                className="rounded-lg border border-compass-200 bg-compass-50 px-3.5 py-2 text-sm font-medium text-compass-700 hover:bg-compass-100 dark:border-compass-800 dark:bg-compass-950/40"
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Filterable / sortable tables --------------------------------------------

export function FilterTable({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [shown, setShown] = useState(0);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

  // Filter + sort operate on the live DOM rows, so arbitrary cell content
  // (links, code, chips) keeps working untouched.
  useEffect(() => {
    const tbody = wrapRef.current?.querySelector("tbody");
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(":scope > tr"));
    setRowCount(rows.length);

    if (sort) {
      const sorted = [...rows].sort((a, b) => {
        const av = a.cells[sort.col]?.textContent?.trim() ?? "";
        const bv = b.cells[sort.col]?.textContent?.trim() ?? "";
        const an = parseFloat(av.replace(/[^0-9.-]/g, ""));
        const bn = parseFloat(bv.replace(/[^0-9.-]/g, ""));
        const numeric = !Number.isNaN(an) && !Number.isNaN(bn) && /\d/.test(av) && /\d/.test(bv);
        return sort.dir * (numeric ? an - bn : av.localeCompare(bv, undefined, { sensitivity: "base" }));
      });
      sorted.forEach((r) => tbody.appendChild(r));
    }

    const q = query.trim().toLowerCase();
    let visible = 0;
    for (const r of rows) {
      const match = !q || (r.textContent ?? "").toLowerCase().includes(q);
      r.style.display = match ? "" : "none";
      if (match) visible++;
    }
    setShown(visible);
  }, [query, sort, children]);

  // Click-to-sort on header cells.
  useEffect(() => {
    const ths = Array.from(wrapRef.current?.querySelectorAll<HTMLTableCellElement>("thead th") ?? []);
    const handlers = ths.map((th, i) => {
      const fn = () =>
        setSort((s) => (s?.col === i ? { col: i, dir: s.dir === 1 ? -1 : 1 } : { col: i, dir: 1 }));
      th.addEventListener("click", fn);
      th.style.cursor = "pointer";
      th.title = "Sort";
      return { th, fn };
    });
    return () => handlers.forEach(({ th, fn }) => th.removeEventListener("click", fn));
  }, [children]);

  const searchable = rowCount >= 4;
  return (
    <div className="md-filter-table">
      {searchable && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter rows…"
              className="w-48 rounded-md border border-slate-200 bg-surface py-1 pl-7 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-compass-400 focus:outline-none"
            />
          </span>
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <ArrowUpDown className="h-3 w-3" /> click a header to sort ·{" "}
            {query ? `${shown}/${rowCount} rows` : `${rowCount} rows`}
          </span>
        </div>
      )}
      <div ref={wrapRef} className="overflow-x-auto">
        <table>{children}</table>
      </div>
    </div>
  );
}

// --- Interactive checklists ---------------------------------------------------

/** GFM task-list checkbox that readers can actually tick. Progress is saved
 * per document in this browser (localStorage), never written to the doc. */
export function ChecklistBox({ storageKey }: { storageKey: string }) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    try {
      setChecked(localStorage.getItem(storageKey) === "1");
    } catch {
      /* storage unavailable */
    }
  }, [storageKey]);

  function toggle() {
    const next = !checked;
    setChecked(next);
    try {
      if (next) localStorage.setItem(storageKey, "1");
      else localStorage.removeItem(storageKey);
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={toggle}
      className="mr-1.5 h-4 w-4 cursor-pointer accent-compass-600 align-middle"
      aria-label="Toggle checklist item (saved on this device)"
    />
  );
}

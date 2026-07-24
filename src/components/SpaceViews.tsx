"use client";

// Alternate layouts for a space page: cards (the original), a sortable table,
// a nested-pages tree, a status/type board, a freshness timeline, and a
// by-tag grouping. A segmented switcher picks the view; the choice persists
// per space per browser, defaulting to the admin-configured space view.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  LayoutGrid,
  Table2,
  ListTree,
  SquareKanban,
  History,
  Tags,
  ChevronRight,
  ArrowUpDown,
  CornerDownRight,
  AlarmClock,
} from "lucide-react";
import { DocCard } from "./DocCard";
import { TypeBadge, StatusBadge } from "./Badges";
import { timeAgo } from "@/lib/ui";
import type { DocumentWithSpace, SpaceView } from "@/lib/types";

interface Category {
  id: number;
  name: string;
}

const TYPE_LABEL: Record<string, string> = {
  sop: "SOPs",
  technical: "Technical",
  policy: "Policies",
  knowledge: "Knowledge",
};

const VIEWS: { key: SpaceView; label: string; icon: React.ReactNode }[] = [
  { key: "cards", label: "Cards", icon: <LayoutGrid className="h-4 w-4" /> },
  { key: "table", label: "Table", icon: <Table2 className="h-4 w-4" /> },
  { key: "tree", label: "Tree", icon: <ListTree className="h-4 w-4" /> },
  { key: "board", label: "Board", icon: <SquareKanban className="h-4 w-4" /> },
  { key: "timeline", label: "Timeline", icon: <History className="h-4 w-4" /> },
  { key: "tags", label: "By tag", icon: <Tags className="h-4 w-4" /> },
];

export function SpaceViews({
  docs,
  categories,
  spaceId,
  defaultView,
  nestedPages,
}: {
  docs: DocumentWithSpace[];
  categories: Category[];
  spaceId: number;
  defaultView: SpaceView;
  nestedPages: boolean;
}) {
  const storageKey = `compass_space_view_${spaceId}`;
  const [view, setView] = useState<SpaceView>(defaultView === "tree" && !nestedPages ? "cards" : defaultView);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey) as SpaceView | null;
      if (saved && VIEWS.some((v) => v.key === saved) && (saved !== "tree" || nestedPages)) {
        setView(saved);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(v: SpaceView) {
    setView(v);
    try {
      localStorage.setItem(storageKey, v);
    } catch {}
  }

  const visible = VIEWS.filter((v) => v.key !== "tree" || nestedPages);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <div className="inline-flex rounded-lg border border-slate-200 bg-surface p-0.5" role="tablist" aria-label="Space layout">
          {visible.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={view === v.key}
              title={v.label}
              onClick={() => pick(v.key)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === v.key
                  ? "bg-compass-600 text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              }`}
            >
              {v.icon}
              <span className="hidden sm:inline">{v.label}</span>
            </button>
          ))}
        </div>
      </div>

      {view === "cards" && <CardsView docs={docs} categories={categories} nestedPages={nestedPages} />}
      {view === "table" && <TableView docs={docs} categories={categories} />}
      {view === "tree" && nestedPages && <TreeView docs={docs} />}
      {view === "board" && <BoardView docs={docs} />}
      {view === "timeline" && <TimelineView docs={docs} />}
      {view === "tags" && <TagsView docs={docs} />}
    </div>
  );
}

// --- Shared helpers ------------------------------------------------------------

/** Category sections: named categories in admin order, then General last —
 *  labeled only when named sections exist (mirrors the original layout). */
function sectionize(docs: DocumentWithSpace[], categories: Category[]) {
  const known = new Set(categories.map((c) => c.id));
  const byCat = new Map<number | null, DocumentWithSpace[]>();
  for (const d of docs) {
    // A category this user can't see (or a deleted one) folds into General.
    const k = d.category_id !== null && known.has(d.category_id) ? d.category_id : null;
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(d);
  }
  const sections: { name: string | null; docs: DocumentWithSpace[] }[] = [];
  for (const c of categories) {
    const list = byCat.get(c.id);
    if (list?.length) sections.push({ name: c.name, docs: list });
  }
  const general = byCat.get(null);
  if (general?.length) {
    sections.push({ name: sections.length > 0 ? "General" : null, docs: general });
  }
  return sections;
}

function byParent(docs: DocumentWithSpace[]) {
  const map = new Map<number, DocumentWithSpace[]>();
  const ids = new Set(docs.map((d) => d.id));
  for (const d of docs) {
    if (d.parent_id !== null && ids.has(d.parent_id)) {
      if (!map.has(d.parent_id)) map.set(d.parent_id, []);
      map.get(d.parent_id)!.push(d);
    }
  }
  for (const kids of map.values()) {
    kids.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  }
  return map;
}

function reviewOverdue(d: DocumentWithSpace) {
  return Boolean(d.review_due_at && new Date(d.review_due_at).getTime() < Date.now());
}

function DocRowLink({ d, indent = 0 }: { d: DocumentWithSpace; indent?: number }) {
  return (
    <Link
      href={`/doc/${d.id}`}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50"
      style={indent ? { paddingLeft: `${0.5 + indent * 1.25}rem` } : undefined}
    >
      {indent > 0 && <CornerDownRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />}
      <span className="min-w-0 truncate font-medium text-slate-700">{d.title}</span>
      <TypeBadge type={d.type} />
      {d.status === "draft" && <StatusBadge status="draft" />}
      <span className="ml-auto shrink-0 text-xs text-slate-400">{timeAgo(d.updated_at)}</span>
    </Link>
  );
}

// --- Cards (the original layout) ----------------------------------------------

function ChildList({
  parentId,
  map,
  depth,
}: {
  parentId: number;
  map: Map<number, DocumentWithSpace[]>;
  depth: number;
}) {
  const kids = map.get(parentId);
  if (!kids?.length || depth > 3) return null;
  return (
    <ul className={`mt-1.5 space-y-0.5 border-l-2 border-slate-100 pl-3 ${depth > 1 ? "ml-1" : "ml-2"}`}>
      {kids.map((k) => (
        <li key={k.id}>
          <Link
            href={`/doc/${k.id}`}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-compass-700"
          >
            <CornerDownRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />
            <span className="min-w-0 truncate" title={k.title}>
              {k.title}
            </span>
            {k.status === "draft" && (
              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-medium uppercase text-slate-500">
                Draft
              </span>
            )}
          </Link>
          <div className="pl-4">
            <ChildList parentId={k.id} map={map} depth={depth + 1} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CardsView({
  docs,
  categories,
  nestedPages,
}: {
  docs: DocumentWithSpace[];
  categories: Category[];
  nestedPages: boolean;
}) {
  const map = useMemo(() => byParent(docs), [docs]);
  // With nesting on, visible children live under their parent's card instead
  // of getting their own; a child whose parent isn't visible stays top-level.
  const topLevel = useMemo(() => {
    if (!nestedPages) return docs;
    const ids = new Set(docs.map((d) => d.id));
    return docs.filter((d) => d.parent_id === null || !ids.has(d.parent_id));
  }, [docs, nestedPages]);
  const sections = useMemo(() => sectionize(topLevel, categories), [topLevel, categories]);
  return (
    <div className="space-y-8">
      {sections.map((s, i) => (
        <section key={s.name ?? `general-${i}`}>
          {s.name && (
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{s.name}</h2>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {s.docs.map((d) => (
              <div key={d.id}>
                <DocCard doc={d} />
                {nestedPages && <ChildList parentId={d.id} map={map} depth={1} />}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// --- Table ---------------------------------------------------------------------

type SortKey = "title" | "type" | "status" | "author" | "updated_at";

function TableView({ docs, categories }: { docs: DocumentWithSpace[]; categories: Category[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updated_at", dir: -1 });

  function toggle(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "updated_at" ? -1 : 1 }));
  }

  const catName = useMemo(() => {
    const m = new Map<number, string>(categories.map((c) => [c.id, c.name]));
    return (d: DocumentWithSpace) => (d.category_id !== null && m.get(d.category_id)) || "General";
  }, [categories]);

  const sorted = useMemo(() => {
    const copy = [...docs];
    copy.sort((a, b) => {
      const va = sort.key === "updated_at" ? a.updated_at : String(a[sort.key] ?? "");
      const vb = sort.key === "updated_at" ? b.updated_at : String(b[sort.key] ?? "");
      return va < vb ? -sort.dir : va > vb ? sort.dir : 0;
    });
    return copy;
  }, [docs, sort]);

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th className="px-3 py-2 text-left">
      <button
        onClick={() => toggle(k)}
        className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider ${
          sort.key === k ? "text-compass-700" : "text-slate-400 hover:text-slate-600"
        }`}
      >
        {children}
        <ArrowUpDown className="h-3 w-3" aria-hidden />
      </button>
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-slate-100">
          <tr>
            <Th k="title">Title</Th>
            <Th k="type">Type</Th>
            <Th k="status">Status</Th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
              Category
            </th>
            <Th k="author">Author</Th>
            <Th k="updated_at">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
              <td className="px-3 py-2">
                <Link href={`/doc/${d.id}`} className="font-medium text-slate-700 hover:text-compass-700">
                  {d.title}
                </Link>
                {reviewOverdue(d) && (
                  <span title="Review overdue" className="ml-2 inline-flex align-middle text-amber-500">
                    <AlarmClock className="h-3.5 w-3.5" aria-label="Review overdue" />
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <TypeBadge type={d.type} />
              </td>
              <td className="px-3 py-2">
                {d.status === "draft" ? <StatusBadge status="draft" /> : <span className="text-slate-500">Published</span>}
              </td>
              <td className="px-3 py-2 text-slate-500">{catName(d)}</td>
              <td className="px-3 py-2 text-slate-500">{d.author}</td>
              <td className="px-3 py-2 whitespace-nowrap text-slate-500" title={d.updated_at}>
                {timeAgo(d.updated_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Tree ----------------------------------------------------------------------

function TreeNode({
  d,
  map,
  depth,
  open,
  onToggle,
}: {
  d: DocumentWithSpace;
  map: Map<number, DocumentWithSpace[]>;
  depth: number;
  open: Set<number>;
  onToggle: (id: number) => void;
}) {
  const kids = map.get(d.id) ?? [];
  const expanded = open.has(d.id);
  return (
    <div>
      <div className="flex items-center" style={{ paddingLeft: `${depth * 1.25}rem` }}>
        {kids.length > 0 ? (
          <button
            onClick={() => onToggle(d.id)}
            title={expanded ? "Collapse" : "Expand"}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${d.title}`}
            className="rounded p-0.5 text-slate-400 hover:text-slate-600"
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        <div className="min-w-0 flex-1">
          <DocRowLink d={d} />
        </div>
      </div>
      {expanded &&
        kids.map((k) => (
          <TreeNode key={k.id} d={k} map={map} depth={depth + 1} open={open} onToggle={onToggle} />
        ))}
    </div>
  );
}

function TreeView({ docs }: { docs: DocumentWithSpace[] }) {
  const map = useMemo(() => byParent(docs), [docs]);
  const ids = useMemo(() => new Set(docs.map((d) => d.id)), [docs]);
  const roots = useMemo(
    () =>
      docs
        .filter((d) => d.parent_id === null || !ids.has(d.parent_id))
        .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title)),
    [docs, ids]
  );
  const [open, setOpen] = useState<Set<number>>(() => new Set(docs.map((d) => d.id)));
  function onToggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-3">
      {roots.map((d) => (
        <TreeNode key={d.id} d={d} map={map} depth={0} open={open} onToggle={onToggle} />
      ))}
    </div>
  );
}

// --- Board ---------------------------------------------------------------------

function BoardView({ docs }: { docs: DocumentWithSpace[] }) {
  const [groupBy, setGroupBy] = useState<"status" | "type">("status");
  const columns = useMemo(() => {
    if (groupBy === "status") {
      return [
        { key: "draft", label: "Drafts", docs: docs.filter((d) => d.status === "draft") },
        { key: "published", label: "Published", docs: docs.filter((d) => d.status === "published") },
        {
          key: "overdue",
          label: "Review overdue",
          docs: docs.filter((d) => reviewOverdue(d)),
        },
      ];
    }
    return (["sop", "technical", "policy", "knowledge"] as const).map((t) => ({
      key: t,
      label: TYPE_LABEL[t],
      docs: docs.filter((d) => d.type === t),
    }));
  }, [docs, groupBy]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs text-slate-500">
        Group by
        {(["status", "type"] as const).map((g) => (
          <button
            key={g}
            onClick={() => setGroupBy(g)}
            className={`rounded-full px-2.5 py-1 font-medium ${
              groupBy === g ? "bg-compass-100 text-compass-700" : "hover:bg-slate-100"
            }`}
          >
            {g === "status" ? "Status" : "Type"}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {columns.map((c) => (
          <div key={c.key} className="rounded-xl border border-slate-200 bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{c.label}</span>
              <span className="rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-500">
                {c.docs.length}
              </span>
            </div>
            <div className="space-y-1">
              {c.docs.length === 0 && <p className="px-2 py-1 text-sm text-slate-400">None</p>}
              {c.docs.map((d) => (
                <DocRowLink key={d.id} d={d} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Timeline ------------------------------------------------------------------

function TimelineView({ docs }: { docs: DocumentWithSpace[] }) {
  const buckets = useMemo(() => {
    const now = Date.now();
    const day = 86400_000;
    const groups: { label: string; test: (age: number) => boolean }[] = [
      { label: "Updated this week", test: (a) => a <= 7 * day },
      { label: "This month", test: (a) => a <= 31 * day },
      { label: "This quarter", test: (a) => a <= 92 * day },
      { label: "Older", test: () => true },
    ];
    const out = groups.map((g) => ({ label: g.label, docs: [] as DocumentWithSpace[] }));
    for (const d of [...docs].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))) {
      const age = now - new Date(d.updated_at).getTime();
      out[groups.findIndex((g) => g.test(age))].docs.push(d);
    }
    return out.filter((b) => b.docs.length);
  }, [docs]);

  const overdue = docs.filter(reviewOverdue);

  return (
    <div className="space-y-6">
      {overdue.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <h2 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-600">
            <AlarmClock className="h-3.5 w-3.5" /> Review overdue
          </h2>
          {overdue.map((d) => (
            <DocRowLink key={d.id} d={d} />
          ))}
        </section>
      )}
      {buckets.map((b) => (
        <section key={b.label}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{b.label}</h2>
          <div className="rounded-xl border border-slate-200 bg-surface p-2">
            {b.docs.map((d) => (
              <DocRowLink key={d.id} d={d} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// --- By tag --------------------------------------------------------------------

function TagsView({ docs }: { docs: DocumentWithSpace[] }) {
  const groups = useMemo(() => {
    const byTag = new Map<string, DocumentWithSpace[]>();
    const untagged: DocumentWithSpace[] = [];
    for (const d of docs) {
      if (!d.tags.length) untagged.push(d);
      for (const t of d.tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t)!.push(d);
      }
    }
    const named = [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { named, untagged };
  }, [docs]);

  return (
    <div className="space-y-6">
      {groups.named.map(([tag, list]) => (
        <section key={tag}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">#{tag}</h2>
          <div className="rounded-xl border border-slate-200 bg-surface p-2">
            {list.map((d) => (
              <DocRowLink key={d.id} d={d} />
            ))}
          </div>
        </section>
      ))}
      {groups.untagged.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Untagged</h2>
          <div className="rounded-xl border border-slate-200 bg-surface p-2">
            {groups.untagged.map((d) => (
              <DocRowLink key={d.id} d={d} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

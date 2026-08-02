"use client";

// Alternate layouts for a space page: cards (the original), a sortable table,
// a nested-pages tree, a status/type board, a freshness timeline, and a
// by-tag grouping. A segmented switcher picks the view; the choice persists
// per space per browser, defaulting to the admin-configured space view.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  bulk = false,
  canPublish = false,
  moveTargets = [],
}: {
  docs: DocumentWithSpace[];
  categories: Category[];
  spaceId: number;
  defaultView: SpaceView;
  nestedPages: boolean;
  /** Show multi-select bulk actions in the table view (user can author here). */
  bulk?: boolean;
  /** Whether bulk Publish/Unpublish apply (approver+, or open approval mode). */
  canPublish?: boolean;
  /** Spaces the user may move documents into. */
  moveTargets?: { id: number; name: string }[];
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
              data-tt={v.label} aria-label={v.label}
              onClick={() => pick(v.key)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === v.key
                  ? "bg-compass-600 text-white shadow-xs"
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
      {view === "table" && (
        <TableView
          docs={docs}
          categories={categories}
          bulk={bulk}
          canPublish={canPublish}
          spaceId={spaceId}
          moveTargets={moveTargets}
        />
      )}
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

/** One document row. `stacked` puts the title on its own line above the
 *  badges/timestamp — in a narrow board column the single-line form squeezes
 *  the title down to a few pixels, because the badges can't shrink. */
function DocRowLink({
  d,
  indent = 0,
  stacked = false,
}: {
  d: DocumentWithSpace;
  indent?: number;
  stacked?: boolean;
}) {
  const meta = (
    <>
      <TypeBadge type={d.type} />
      {d.status === "draft" && <StatusBadge status="draft" />}
      <span className="ml-auto shrink-0 text-xs text-slate-500">{timeAgo(d.updated_at)}</span>
    </>
  );
  return (
    <Link
      href={`/doc/${d.id}`}
      className={`min-w-0 rounded-md px-2 py-1.5 hover:bg-slate-50 ${
        stacked ? "block" : "flex items-center gap-2"
      }`}
      style={indent ? { paddingLeft: `${0.5 + indent * 1.25}rem` } : undefined}
    >
      {stacked ? (
        <>
          <span className="block truncate font-medium text-slate-700" title={d.title}>
            {d.title}
          </span>
          <span className="mt-1 flex items-center gap-2">{meta}</span>
        </>
      ) : (
        <>
          {indent > 0 && (
            <CornerDownRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />
          )}
          <span className="min-w-0 truncate font-medium text-slate-700" title={d.title}>
            {d.title}
          </span>
          {meta}
        </>
      )}
    </Link>
  );
}

// --- Cards (the original layout) ----------------------------------------------

/** The sub-page tree under a card, flattened to (doc, depth) rows so the
 *  visible-count cap spans the whole subtree, not just one level. */
function flattenSubtree(
  parentId: number,
  map: Map<number, DocumentWithSpace[]>,
  depth = 1,
  out: { doc: DocumentWithSpace; depth: number }[] = []
): { doc: DocumentWithSpace; depth: number }[] {
  if (depth > 3) return out;
  for (const k of map.get(parentId) ?? []) {
    out.push({ doc: k, depth });
    flattenSubtree(k.id, map, depth + 1, out);
  }
  return out;
}

/** How many sub-page rows a card shows before folding into "+ N more". */
const CARD_SUBS_CAP = 4;

function CardSubs({ parentId, map }: { parentId: number; map: Map<number, DocumentWithSpace[]> }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => flattenSubtree(parentId, map), [parentId, map]);
  if (!rows.length) return null;
  // Folding a single row behind a "+ 1 more" button would be pure friction —
  // only fold when at least two rows are hidden.
  const fold = !expanded && rows.length > CARD_SUBS_CAP + 1;
  const visible = fold ? rows.slice(0, CARD_SUBS_CAP) : rows;
  return (
    <ul className="ml-2 mt-1.5 space-y-0.5 border-l-2 border-slate-100 pl-3">
      {visible.map(({ doc: k, depth }) => (
        <li key={k.id} style={depth > 1 ? { paddingLeft: (depth - 1) * 16 } : undefined}>
          <Link
            href={`/doc/${k.id}`}
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-compass-700"
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
        </li>
      ))}
      {fold && (
        <li>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-sm font-medium text-compass-700 hover:bg-slate-50"
          >
            <CornerDownRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />
            {rows.length - CARD_SUBS_CAP} more sub-pages…
          </button>
        </li>
      )}
      {expanded && rows.length > CARD_SUBS_CAP + 1 && (
        <li>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs font-medium text-slate-400 hover:bg-slate-50 hover:text-slate-600"
          >
            show fewer
          </button>
        </li>
      )}
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
          {/* CSS-column masonry: cards pack top-to-bottom, so one sub-heavy
              card can't open a row-height hole beside its neighbors. */}
          <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
            {s.docs.map((d) => (
              <div key={d.id} className="mb-4 break-inside-avoid">
                <DocCard doc={d} />
                {nestedPages && <CardSubs parentId={d.id} map={map} />}
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

function TableView({
  docs,
  categories,
  bulk = false,
  canPublish = false,
  spaceId,
  moveTargets = [],
}: {
  docs: DocumentWithSpace[];
  categories: Category[];
  bulk?: boolean;
  canPublish?: boolean;
  spaceId?: number;
  moveTargets?: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updated_at", dir: -1 });

  // Multi-select for bulk actions.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const toggleOne = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function runBulk(payload: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/documents/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: "err", text: data?.error || "Bulk action failed." });
      } else {
        const skipped: { title: string; reason: string }[] = data.skipped ?? [];
        setNotice({
          kind: "ok",
          text:
            `Updated ${data.updated} document${data.updated === 1 ? "" : "s"}.` +
            (skipped.length
              ? ` Skipped ${skipped.length}: ${skipped
                  .slice(0, 3)
                  .map((s) => `${s.title} (${s.reason})`)
                  .join(", ")}${skipped.length > 3 ? ", …" : ""}`
              : ""),
        });
        setSelected(new Set());
        // Server data changed; re-fetch it while keeping the notice visible.
        router.refresh();
      }
    } catch {
      setNotice({ kind: "err", text: "Bulk action failed." });
    }
    setBusy(false);
  }

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

  const allSelected = selected.size > 0 && selected.size === sorted.length;

  return (
    <div>
      {bulk && selected.size > 0 && (
        <BulkBar
          count={selected.size}
          busy={busy}
          canPublish={canPublish}
          spaceId={spaceId}
          moveTargets={moveTargets}
          onRun={runBulk}
          onClear={() => setSelected(new Set())}
        />
      )}
      {notice && (
        <div
          role="status"
          className={`mb-2 rounded-lg px-3 py-2 text-sm ${
            notice.kind === "ok"
              ? "border border-green-200 bg-green-50 text-green-800"
              : "border border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {notice.text}
        </div>
      )}
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-surface">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-slate-100">
          <tr>
            {bulk && (
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={allSelected ? "Deselect all" : "Select all"}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(sorted.map((d) => d.id)))
                  }
                />
              </th>
            )}
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
              {bulk && (
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${d.title}`}
                    checked={selected.has(d.id)}
                    onChange={() => toggleOne(d.id)}
                  />
                </td>
              )}
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
    </div>
  );
}

/** Action bar shown while table rows are selected: move, status, type, tags. */
function BulkBar({
  count,
  busy,
  canPublish,
  spaceId,
  moveTargets,
  onRun,
  onClear,
}: {
  count: number;
  busy: boolean;
  /** Publish/Unpublish need publish rights; hidden when the user lacks them. */
  canPublish: boolean;
  spaceId?: number;
  moveTargets: { id: number; name: string }[];
  onRun: (payload: Record<string, unknown>) => void;
  onClear: () => void;
}) {
  const [moveTo, setMoveTo] = useState("");
  const [tag, setTag] = useState("");
  const targets = moveTargets.filter((t) => t.id !== spaceId);
  const sel =
    "rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs text-slate-700";
  const btn =
    "rounded-md border border-slate-300 bg-surface px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50";

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2">
      <span className="text-sm font-semibold text-compass-800">
        {count} selected
      </span>
      <button onClick={onClear} disabled={busy} className="text-xs font-medium text-slate-500 hover:underline">
        Clear
      </button>
      <span className="mx-1 h-4 w-px bg-compass-200" aria-hidden />
      {canPublish && (
        <>
          <button onClick={() => onRun({ action: "status", status: "published" })} disabled={busy} className={btn}>
            Publish
          </button>
          <button onClick={() => onRun({ action: "status", status: "draft" })} disabled={busy} className={btn}>
            Unpublish
          </button>
        </>
      )}
      <label className="flex items-center gap-1 text-xs text-slate-600">
        Type
        <select
          className={sel}
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) onRun({ action: "type", type: e.target.value });
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            set…
          </option>
          <option value="sop">SOP</option>
          <option value="technical">Technical</option>
          <option value="policy">Policy</option>
          <option value="knowledge">Knowledge</option>
        </select>
      </label>
      {targets.length > 0 && (
        <label className="flex items-center gap-1 text-xs text-slate-600">
          Move to
          <select className={sel} value={moveTo} disabled={busy} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">space…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => moveTo && onRun({ action: "move", space_id: Number(moveTo) })}
            disabled={busy || !moveTo}
            className={btn}
          >
            Move
          </button>
        </label>
      )}
      <label className="flex items-center gap-1 text-xs text-slate-600">
        Tag
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          disabled={busy}
          placeholder="tag name"
          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs"
        />
        <button onClick={() => tag.trim() && onRun({ action: "add_tag", tag: tag.trim() })} disabled={busy || !tag.trim()} className={btn}>
          Add
        </button>
        <button onClick={() => tag.trim() && onRun({ action: "remove_tag", tag: tag.trim() })} disabled={busy || !tag.trim()} className={btn}>
          Remove
        </button>
      </label>
      {busy && <span className="text-xs text-slate-500">Working…</span>}
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
            data-tt={expanded ? "Collapse" : "Expand"}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${d.title}`}
            className="rounded-sm p-0.5 text-slate-400 hover:text-slate-600"
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
      {/* auto-fit rather than a fixed xl:grid-cols-4: columns keep a usable
          minimum on a phone and take the extra room on a wide monitor. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-4">
        {columns.map((c) => (
          <div key={c.key} className="min-w-0 rounded-xl border border-slate-200 bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{c.label}</span>
              <span className="rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-500">
                {c.docs.length}
              </span>
            </div>
            <div className="space-y-1">
              {c.docs.length === 0 && <p className="px-2 py-1 text-sm text-slate-500">None</p>}
              {c.docs.map((d) => (
                <DocRowLink key={d.id} d={d} stacked />
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

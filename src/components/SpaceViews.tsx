"use client";

// Alternate layouts for a space page: cards (the original), a sortable table,
// a nested-pages tree, a status/type board, a freshness timeline, and a
// by-tag grouping. A segmented switcher picks the view; the choice persists
// per space per browser, defaulting to the admin-configured space view.

import { useEffect, useMemo, useState } from "react";
import { RelativeTime } from "./RelativeTime";
import { chipClass } from "@/components/Chip";
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
  CornerDownRight,
  AlarmClock,
} from "lucide-react";
import { Table, Th, Td, TABLE_HEAD_ROW, TR } from "@/components/Table";
import { DocCard } from "./DocCard";
import { Segmented } from "./Segmented";
import type { LucideIcon } from "lucide-react";
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

const VIEWS: { key: SpaceView; label: string; icon: LucideIcon }[] = [
  { key: "cards", label: "Cards", icon: LayoutGrid },
  { key: "table", label: "Table", icon: Table2 },
  { key: "tree", label: "Tree", icon: ListTree },
  { key: "board", label: "Board", icon: SquareKanban },
  { key: "timeline", label: "Timeline", icon: History },
  { key: "tags", label: "By tag", icon: Tags },
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
      {/* The one segmented control (STYLEGUIDE §Segmented controls), not a
          tab list that never behaved like one (1.9.3). */}
      <div className="mb-4 flex justify-end">
        <Segmented
          label="Space layout"
          size="sm"
          options={visible.map((v) => ({ value: v.key, label: v.label, icon: v.icon }))}
          value={view}
          onChange={pick}
        />
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
      <RelativeTime value={d.updated_at} className="ml-auto shrink-0 text-xs text-slate-500" />
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
              <span className={chipClass("neutral", "sm", "shrink-0")}>
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
            className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-600"
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
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{s.name}</h2>
          )}
          {/* CSS-column masonry: cards pack top-to-bottom, so one sub-heavy
              card can't open a row-height hole beside its neighbors. 18rem
              columns, so the count follows the page width, not the viewport. */}
          <div className="columns-2xs gap-4">
            {s.docs.map((d) => (
              <div key={d.id} className="mb-4 break-inside-avoid">
                <DocCard doc={d} inSpace />
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

  // The kit's <Th sort> wants "asc" | "desc"; the component keeps its 1 | -1.
  const sortBy = (key: SortKey) => ({
    key,
    by: sort.key,
    dir: sort.dir === 1 ? ("asc" as const) : ("desc" as const),
    onSort: (k: string) => toggle(k as SortKey),
  });

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
          className={`mb-2 rounded-lg border px-3 py-2 text-sm ${
            notice.kind === "ok" ? "notice-ok" : "notice-error"
          }`}
        >
          {notice.text}
        </div>
      )}
    <div className="rounded-xl border border-slate-200 bg-surface">
      <Table scroll minWidth="40rem">
        <thead className={TABLE_HEAD_ROW}>
          <tr>
            {bulk && (
              <Th fit>
                <input
                  type="checkbox"
                  aria-label={allSelected ? "Deselect all" : "Select all"}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(sorted.map((d) => d.id)))
                  }
                />
              </Th>
            )}
            <Th sort={sortBy("title")}>Title</Th>
            <Th sort={sortBy("type")}>Type</Th>
            <Th sort={sortBy("status")}>Status</Th>
            <Th>Category</Th>
            <Th fit sort={sortBy("author")}>Author</Th>
            <Th fit sort={sortBy("updated_at")}>Updated</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.id} className={TR}>
              {bulk && (
                <Td fit>
                  <input
                    type="checkbox"
                    aria-label={`Select ${d.title}`}
                    checked={selected.has(d.id)}
                    onChange={() => toggleOne(d.id)}
                  />
                </Td>
              )}
              <Td>
                <Link href={`/doc/${d.id}`} className="font-medium text-slate-700 hover:text-compass-700">
                  {d.title}
                </Link>
                {reviewOverdue(d) && (
                  <span data-tt="Review overdue" className="ml-2 inline-flex align-middle text-amber-500">
                    <AlarmClock className="h-3.5 w-3.5" aria-label="Review overdue" />
                  </span>
                )}
              </Td>
              <Td>
                <TypeBadge type={d.type} />
              </Td>
              <Td>
                {d.status === "draft" ? <StatusBadge status="draft" /> : <span className="text-slate-500">Published</span>}
              </Td>
              <Td className="text-slate-500">{catName(d)}</Td>
              <Td fit className="text-slate-500">{d.author}</Td>
              <Td fit className="text-slate-500">
                <RelativeTime value={d.updated_at} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
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
          <span className="w-4.5" />
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-4">
        {columns.map((c) => (
          <div key={c.key} className="min-w-0 rounded-xl border border-slate-200 bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{c.label}</span>
              <span className={chipClass("neutral")}>
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
        <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-800/60 dark:bg-amber-950/30">
          <h2 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ink-warn">
            <AlarmClock className="h-3.5 w-3.5" /> Review overdue
          </h2>
          {overdue.map((d) => (
            <DocRowLink key={d.id} d={d} />
          ))}
        </section>
      )}
      {buckets.map((b) => (
        <section key={b.label}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{b.label}</h2>
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
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">#{tag}</h2>
          <div className="rounded-xl border border-slate-200 bg-surface p-2">
            {list.map((d) => (
              <DocRowLink key={d.id} d={d} />
            ))}
          </div>
        </section>
      ))}
      {groups.untagged.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Untagged</h2>
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

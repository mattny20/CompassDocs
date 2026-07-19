"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  GitBranch,
  History,
  LoaderCircle,
  RotateCcw,
  Columns2,
  AlignJustify,
} from "lucide-react";
import { diffLines, diffStats, withFolds } from "@/lib/diff";
import type { DiffRow, DiffSegment, DisplayRow } from "@/lib/diff";

// Version-history explorer: pick any two versions to compare (side-by-side or
// inline), restore an older version, and manage draft branches. The diff is
// computed in the browser from content shipped with the page.

export type VersionItem = {
  id: number;
  rev: number;
  title: string;
  content: string;
  author: string;
  note: string;
  restored_from: number | null;
  /** Pre-formatted timestamp (server-rendered with workspace settings). */
  when: string;
  whenExact: string;
};

export type BranchItem = {
  id: number;
  title: string;
  author: string;
  when: string;
};

function Segments({ segs, text }: { segs?: DiffSegment[]; text: string }) {
  if (!segs) return <>{text || " "}</>;
  return (
    <>
      {segs.map((s, i) =>
        s.changed ? (
          <mark key={i} className="rounded-sm bg-amber-200/80 px-0 text-inherit dark:bg-amber-500/40">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
      {text === "" && " "}
    </>
  );
}

const CELL: Record<string, string> = {
  same: "bg-transparent",
  del: "bg-red-50 dark:bg-red-950/40",
  add: "bg-emerald-50 dark:bg-emerald-950/40",
};

function LineNo({ n }: { n?: number }) {
  return (
    <td className="w-10 select-none border-r border-slate-100 px-1 py-0 text-right align-top text-[11px] leading-5 text-slate-300">
      {n ?? ""}
    </td>
  );
}

function FoldRow({ hidden, cols, onExpand }: { hidden: number; cols: number; onExpand: () => void }) {
  return (
    <tr>
      <td colSpan={cols} className="bg-slate-50/80 px-2 py-0.5 text-center dark:bg-slate-800/40">
        <button
          onClick={onExpand}
          className="text-[11px] font-medium text-compass-600 hover:underline"
        >
          ⋯ {hidden} unchanged line{hidden === 1 ? "" : "s"} — show
        </button>
      </td>
    </tr>
  );
}

/** Pair rows for the side-by-side table: same → both sides; del/add runs are
 * zipped positionally so replacements line up. */
function pairRows(rows: DiffRow[]): Array<{ left?: DiffRow; right?: DiffRow }> {
  const out: Array<{ left?: DiffRow; right?: DiffRow }> = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === "same") {
      out.push({ left: r, right: r });
      i++;
      continue;
    }
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i].type !== "same") {
      (rows[i].type === "del" ? dels : adds).push(rows[i]);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ left: dels[k], right: adds[k] });
    }
  }
  return out;
}

export function VersionHistory({
  docId,
  docStatus,
  isBranch,
  canEdit,
  canPublishDirect,
  versions,
  branches,
}: {
  docId: number;
  docStatus: string;
  isBranch: boolean;
  canEdit: boolean;
  /** False = restores on a published doc go to the review queue. */
  canPublishDirect: boolean;
  versions: VersionItem[];
  branches: BranchItem[];
}) {
  const router = useRouter();
  // Default compare: previous vs current (when there are at least two).
  const [oldId, setOldId] = useState<number | null>(versions[1]?.id ?? null);
  const [newId, setNewId] = useState<number | null>(versions[0]?.id ?? null);
  const [mode, setMode] = useState<"split" | "inline">("split");
  const [expanded, setExpanded] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [branching, setBranching] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const oldV = versions.find((v) => v.id === oldId);
  const newV = versions.find((v) => v.id === newId);

  const rows = useMemo(() => {
    if (!oldV || !newV || oldV.id === newV.id) return null;
    return diffLines(oldV.content, newV.content);
  }, [oldV, newV]);
  const stats = useMemo(() => (rows ? diffStats(rows) : null), [rows]);
  const display: DisplayRow[] | null = useMemo(() => {
    if (!rows) return null;
    return expanded ? rows : withFolds(rows);
  }, [rows, expanded]);

  async function restore(v: VersionItem) {
    const applies = docStatus !== "published" || canPublishDirect;
    const q = applies
      ? `Restore version ${v.rev}? The current content stays in the history — this adds a new version with the older text.`
      : `Restore version ${v.rev}? Your restore will be submitted to the review queue.`;
    if (!confirm(q)) return;
    setRestoring(v.id);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/documents/${docId}/versions/${v.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: String(v.rev) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Restore failed.");
      if (data.pending) {
        setNotice("Restore submitted for review — an approver or admin will apply it.");
      } else {
        router.push(`/doc/${docId}`);
        router.refresh();
        return;
      }
    } catch (e: any) {
      setError(e.message || "Restore failed.");
    } finally {
      setRestoring(null);
    }
  }

  async function createBranch() {
    setBranching(true);
    setError("");
    try {
      const res = await fetch(`/api/documents/${docId}/branch`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Couldn't create the branch.");
      router.push(`/doc/${data.branch.id}/edit`);
      router.refresh();
    } catch (e: any) {
      setError(e.message || "Couldn't create the branch.");
      setBranching(false);
    }
  }

  const pillBtn = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium ${
      active
        ? "bg-compass-600 text-white"
        : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
    }`;

  return (
    <div className="space-y-6">
      {(notice || error) && (
        <div
          className={`rounded-lg border px-4 py-2 text-sm ${
            error
              ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800/60 dark:bg-red-950/40"
              : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/40"
          }`}
        >
          {error || notice}
        </div>
      )}

      {/* Draft branches */}
      {canEdit && !isBranch && (
        <section className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                <GitBranch className="h-4 w-4 text-compass-600" /> Draft branches
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Work on a private copy, then merge it back — the live document stays untouched
                while you draft.
              </p>
            </div>
            <button
              onClick={createBranch}
              disabled={branching}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {branching ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitBranch className="h-3.5 w-3.5" />
              )}
              New draft branch
            </button>
          </div>
          {branches.length > 0 && (
            <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
              {branches.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link href={`/doc/${b.id}`} className="font-medium text-compass-700 hover:underline">
                    {b.title}
                  </Link>
                  <span className="shrink-0 text-xs text-slate-400">
                    {b.author} · {b.when}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Compare panel */}
      {rows && oldV && newV && stats && display && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
            <div className="text-sm font-medium text-slate-700">
              Comparing <span className="font-semibold">v{oldV.rev}</span> →{" "}
              <span className="font-semibold">v{newV.rev}</span>
              <span className="ml-3 text-xs font-normal">
                <span className="text-emerald-600">+{stats.added}</span>{" "}
                <span className="text-red-500">−{stats.removed}</span>
                {oldV.title !== newV.title && (
                  <span className="ml-2 text-slate-400">· title changed</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
              <button className={pillBtn(mode === "split")} onClick={() => setMode("split")}>
                <Columns2 className="h-3.5 w-3.5" /> Side by side
              </button>
              <button className={pillBtn(mode === "inline")} onClick={() => setMode("inline")}>
                <AlignJustify className="h-3.5 w-3.5" /> Inline
              </button>
            </div>
          </div>
          {oldV.title !== newV.title && (
            <div className="border-b border-slate-100 px-4 py-2 font-mono text-xs">
              <div className={`rounded px-2 py-0.5 ${CELL.del}`}>
                <span className="mr-1 select-none text-red-400">−</span>
                {oldV.title}
              </div>
              <div className={`mt-0.5 rounded px-2 py-0.5 ${CELL.add}`}>
                <span className="mr-1 select-none text-emerald-500">+</span>
                {newV.title}
              </div>
            </div>
          )}
          <div className="max-h-[540px] overflow-auto">
            {mode === "inline" ? (
              <table className="w-full border-collapse font-mono text-xs">
                <tbody>
                  {display.map((r, i) =>
                    r.type === "fold" ? (
                      <FoldRow key={i} hidden={r.hidden} cols={3} onExpand={() => setExpanded(true)} />
                    ) : (
                      <tr key={i} className={CELL[r.type]}>
                        <LineNo n={r.leftNo} />
                        <LineNo n={r.rightNo} />
                        <td className="whitespace-pre-wrap break-words px-2 py-0 leading-5 text-slate-700">
                          <span className="mr-1 select-none text-slate-300">
                            {r.type === "del" ? "−" : r.type === "add" ? "+" : " "}
                          </span>
                          <Segments segs={r.segments} text={r.text} />
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            ) : (
              <SplitView display={display} onExpand={() => setExpanded(true)} />
            )}
          </div>
        </section>
      )}

      {/* Timeline */}
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <History className="h-4 w-4 text-compass-600" /> All versions
          <span className="font-normal text-slate-400">
            — select two to compare ({versions.length} total)
          </span>
        </h2>
        <ol className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-sm">
          {versions.map((v, i) => {
            const isCurrent = i === 0;
            return (
              <li
                key={v.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-2.5 last:border-b-0 ${
                  v.id === oldId || v.id === newId ? "bg-compass-50/60 dark:bg-compass-950/30" : ""
                }`}
              >
                <span className="flex items-center gap-2 text-xs text-slate-400">
                  <label className="flex cursor-pointer items-center gap-1" title="Compare from (older)">
                    <input
                      type="radio"
                      name="cmp-old"
                      checked={oldId === v.id}
                      onChange={() => setOldId(v.id)}
                      className="accent-compass-600"
                    />
                    A
                  </label>
                  <label className="flex cursor-pointer items-center gap-1" title="Compare to (newer)">
                    <input
                      type="radio"
                      name="cmp-new"
                      checked={newId === v.id}
                      onChange={() => setNewId(v.id)}
                      className="accent-compass-600"
                    />
                    B
                  </label>
                </span>
                <span className="font-medium text-slate-800">
                  v{v.rev}
                  {isCurrent && (
                    <span className="ml-1.5 rounded-full bg-compass-100 px-1.5 py-0.5 text-[10px] font-semibold text-compass-700 dark:bg-compass-900/60">
                      Current
                    </span>
                  )}
                  {v.restored_from !== null && (
                    <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/50">
                      Restored
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-500" title={v.note}>
                  {v.note}
                </span>
                <span className="text-xs text-slate-400" title={v.whenExact}>
                  {v.author} · {v.when}
                </span>
                {canEdit && !isCurrent && (
                  <button
                    onClick={() => restore(v)}
                    disabled={restoring !== null}
                    title={
                      docStatus === "published" && !canPublishDirect
                        ? "Submits to the review queue"
                        : "Make this the current version"
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {restoring === v.id ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Restore
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function SplitView({ display, onExpand }: { display: DisplayRow[]; onExpand: () => void }) {
  // Rebuild pairs from the display list, preserving fold markers.
  const chunks: Array<{ fold?: number; pairs?: Array<{ left?: DiffRow; right?: DiffRow }> }> = [];
  let buf: DiffRow[] = [];
  const flush = () => {
    if (buf.length) chunks.push({ pairs: pairRows(buf) });
    buf = [];
  };
  for (const r of display) {
    if (r.type === "fold") {
      flush();
      chunks.push({ fold: r.hidden });
    } else buf.push(r);
  }
  flush();

  return (
    <table className="w-full table-fixed border-collapse font-mono text-xs">
      <tbody>
        {chunks.flatMap((c, ci) => {
          if (c.fold !== undefined) {
            return [<FoldRow key={`f${ci}`} hidden={c.fold} cols={4} onExpand={onExpand} />];
          }
          return (c.pairs ?? []).map((p, pi) => (
            <tr key={`${ci}-${pi}`}>
              <LineNo n={p.left?.leftNo} />
              <td
                className={`w-1/2 whitespace-pre-wrap break-words border-r border-slate-100 px-2 py-0 leading-5 text-slate-700 ${
                  p.left ? CELL[p.left.type] : "bg-slate-50/60 dark:bg-slate-800/30"
                }`}
              >
                {p.left ? <Segments segs={p.left.segments} text={p.left.text} /> : null}
              </td>
              <LineNo n={p.right?.rightNo} />
              <td
                className={`w-1/2 whitespace-pre-wrap break-words px-2 py-0 leading-5 text-slate-700 ${
                  p.right ? CELL[p.right.type] : "bg-slate-50/60 dark:bg-slate-800/30"
                }`}
              >
                {p.right ? <Segments segs={p.right.segments} text={p.right.text} /> : null}
              </td>
            </tr>
          ));
        })}
      </tbody>
    </table>
  );
}

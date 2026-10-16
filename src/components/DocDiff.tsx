"use client";

// The rendered block diff as a component (A3, 1.10.0): what changed between
// two texts, through the real markdown pipeline. Removed blocks are tinted
// red (with a "Removed" label), added blocks green; long unchanged runs fold
// so the changes stay in view. Lifted from the version history's compare
// view so the re-confirmation question can show the same evidence; the
// history page keeps its own copy until it is swapped for this one.

import { useMemo, useState } from "react";
import { diffBlocks } from "@/lib/diff";
import type { BlockDiffRow } from "@/lib/diff";
import { SectionEmpty } from "./form";
import { MarkdownView } from "./MarkdownView";

const CELL: Record<string, string> = {
  del: "bg-red-50 dark:bg-red-950/40",
  add: "bg-emerald-50 dark:bg-emerald-950/40",
};

export function DocDiff({
  oldText,
  newText,
  oldTitle,
  newTitle,
  docKey,
  className = "",
}: {
  oldText: string;
  newText: string;
  /** When both titles are given and differ, the title change leads the diff. */
  oldTitle?: string;
  newTitle?: string;
  /** Namespaces checklist state inside rendered blocks (MarkdownView). */
  docKey: string;
  className?: string;
}) {
  const blocks = useMemo(() => diffBlocks(oldText, newText), [oldText, newText]);
  const [expanded, setExpanded] = useState(false);
  const titleChanged = oldTitle != null && newTitle != null && oldTitle.trim() !== newTitle.trim();
  const textChanged = blocks.some((b) => b.type !== "same");

  if (!textChanged && !titleChanged) {
    return <SectionEmpty className={`px-5 py-4 ${className}`.trim()}>No changes to the text.</SectionEmpty>;
  }

  return (
    <div className={className}>
      {titleChanged && (
        <div className="border-b border-slate-100 px-4 py-2 font-mono text-xs">
          <div className={`rounded-sm px-2 py-0.5 ${CELL.del}`}>
            <span className="mr-1 select-none text-red-400">−</span>
            {oldTitle}
          </div>
          <div className={`mt-0.5 rounded-sm px-2 py-0.5 ${CELL.add}`}>
            <span className="mr-1 select-none text-emerald-500">+</span>
            {newTitle}
          </div>
        </div>
      )}
      {textChanged && (
        <RenderedDiff blocks={blocks} docKey={docKey} expanded={expanded} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}

/** Doc-layout compare: blocks render through the real markdown pipeline. */
function RenderedDiff({
  blocks,
  docKey,
  expanded,
  onExpand,
}: {
  blocks: BlockDiffRow[];
  docKey: string;
  expanded: boolean;
  onExpand: () => void;
}) {
  // Zip each changed run pairwise (old block directly above its replacement)
  // so a rewritten section reads Removed then Added, not all-removed-then-all-added.
  const zipped: BlockDiffRow[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === "same") {
      zipped.push(blocks[i++]);
      continue;
    }
    const dels: BlockDiffRow[] = [];
    const adds: BlockDiffRow[] = [];
    while (i < blocks.length && blocks[i].type !== "same") {
      (blocks[i].type === "del" ? dels : adds).push(blocks[i]);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      if (dels[k]) zipped.push(dels[k]);
      if (adds[k]) zipped.push(adds[k]);
    }
  }

  // Fold unchanged runs (keep one block of context around each change).
  type Chunk = { fold?: number; rows?: Array<BlockDiffRow & { key: number }> };
  const keyed = zipped.map((b, i) => ({ ...b, key: i }));
  const chunks: Chunk[] = [];
  if (expanded) {
    chunks.push({ rows: keyed });
  } else {
    const keep = new Array<boolean>(keyed.length).fill(false);
    keyed.forEach((b, i) => {
      if (b.type !== "same") {
        for (let k = Math.max(0, i - 1); k <= Math.min(keyed.length - 1, i + 1); k++) keep[k] = true;
      }
    });
    let hidden = 0;
    let buf: Array<BlockDiffRow & { key: number }> = [];
    const flush = () => {
      if (buf.length) chunks.push({ rows: buf });
      buf = [];
    };
    keyed.forEach((b, i) => {
      if (keep[i]) {
        if (hidden > 0) {
          flush();
          chunks.push({ fold: hidden });
          hidden = 0;
        }
        buf.push(b);
      } else hidden++;
    });
    flush();
    if (hidden > 0) chunks.push({ fold: hidden });
  }

  const tint: Record<BlockDiffRow["type"], string> = {
    same: "",
    del: "rounded-lg border-l-2 border-red-300 bg-red-50/70 px-3 py-1 opacity-75 dark:border-red-800 dark:bg-red-950/30",
    add: "rounded-lg border-l-2 border-emerald-300 bg-emerald-50/70 px-3 py-1 dark:border-emerald-800 dark:bg-emerald-950/30",
  };

  return (
    <article className="space-y-3 px-5 py-4">
      {chunks.map((c, ci) =>
        c.fold !== undefined ? (
          <div key={`f${ci}`} className="rounded-md bg-slate-50/80 py-1 text-center">
            <button type="button" onClick={onExpand} className="text-2xs font-medium text-compass-600 hover:underline">
              Show {c.fold} unchanged section{c.fold === 1 ? "" : "s"}
            </button>
          </div>
        ) : (
          (c.rows ?? []).map((b) => (
            <div key={b.key} className={tint[b.type]}>
              {b.type === "del" && (
                <div className="mb-1 text-3xs font-semibold uppercase tracking-wider text-red-500">
                  Removed
                </div>
              )}
              <MarkdownView content={b.text} docKey={`${docKey}-${b.key}`} />
            </div>
          ))
        )
      )}
    </article>
  );
}

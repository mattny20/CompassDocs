"use client";

// Sub-pages card in the doc side panel (nested pages, admin-gated): the
// document's children in manual order, with reorder arrows for editors and a
// "New sub-page" shortcut that lands in the editor with the parent preset.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronRight, ChevronUp, FileText, ListTree } from "lucide-react";
import { usePanelCollapse } from "@/lib/use-panel-collapse";

export interface SubPage {
  id: number;
  title: string;
  status: string;
}

export function SubPages({
  parentId,
  spaceSlug,
  initial,
  canEdit,
  canAddChild,
}: {
  parentId: number;
  spaceSlug: string;
  initial: SubPage[];
  canEdit: boolean;
  /** False once the parent sits at the depth cap. */
  canAddChild: boolean;
}) {
  const router = useRouter();
  const [pages, setPages] = useState<SubPage[]>(initial);
  const [busy, setBusy] = useState(false);
  // Empty sections start tucked away — the header (with its + New shortcut)
  // is all an editor needs until there's content.
  const [open, toggleOpen] = usePanelCollapse("subpages", initial.length > 0);

  if (pages.length === 0 && !(canEdit && canAddChild)) return null;

  async function move(idx: number, dir: -1 | 1) {
    const other = idx + dir;
    if (other < 0 || other >= pages.length) return;
    setBusy(true);
    const res = await fetch(`/api/documents/${pages[idx].id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (res.ok) {
      const next = [...pages];
      [next[idx], next[other]] = [next[other], next[idx]];
      setPages(next);
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={toggleOpen}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
          <ListTree className="h-3.5 w-3.5" aria-hidden />
          Sub-pages{pages.length > 0 && ` (${pages.length})`}
        </button>
        {canEdit && canAddChild && (
          <Link
            href={`/doc/new?space=${spaceSlug}&parent=${parentId}`}
            data-tt="New sub-page" aria-label="New sub-page"
            className="shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-surface px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {"＋ New"}
          </Link>
        )}
      </div>
      {!open ? null : pages.length === 0 ? (
        <p className="text-sm text-slate-500">No sub-pages yet.</p>
      ) : (
        <ul className="space-y-1">
          {pages.map((p, i) => (
            <li key={p.id} className="group flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <Link
                href={`/doc/${p.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 hover:text-compass-600"
                data-tt={p.title} aria-label={p.title}
              >
                {p.title}
              </Link>
              {p.status === "draft" && (
                <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-medium uppercase text-slate-500">
                  Draft
                </span>
              )}
              {/* focus-within (not focus-visible) — the reveal has to survive Tab landing
                  on either of the two buttons inside. Hiding is gated on hover existing;
                  see StatusBoard. */}
              {canEdit && pages.length > 1 && (
                <span className="flex shrink-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={busy || i === 0}
                    data-tt="Move up"
                    aria-label={`Move ${p.title} up`}
                    className="rounded-sm p-0.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={busy || i === pages.length - 1}
                    data-tt="Move down"
                    aria-label={`Move ${p.title} down`}
                    className="rounded-sm p-0.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

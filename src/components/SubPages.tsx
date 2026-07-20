"use client";

// Sub-pages card in the doc side panel (nested pages, admin-gated): the
// document's children in manual order, with reorder arrows for editors and a
// "New sub-page" shortcut that lands in the editor with the parent preset.

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, FileText, Plus } from "lucide-react";

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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Sub-pages{pages.length > 0 && ` (${pages.length})`}
        </h2>
        {canEdit && canAddChild && (
          <Link
            href={`/doc/new?space=${spaceSlug}&parent=${parentId}`}
            title="New sub-page"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-compass-700 hover:bg-compass-50"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </Link>
        )}
      </div>
      {pages.length === 0 ? (
        <p className="text-sm text-slate-400">No sub-pages yet.</p>
      ) : (
        <ul className="space-y-1">
          {pages.map((p, i) => (
            <li key={p.id} className="group flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <Link
                href={`/doc/${p.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700 hover:text-compass-600"
                title={p.title}
              >
                {p.title}
              </Link>
              {p.status === "draft" && (
                <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-medium uppercase text-slate-500">
                  Draft
                </span>
              )}
              {canEdit && pages.length > 1 && (
                <span className="flex shrink-0 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={busy || i === 0}
                    title="Move up"
                    aria-label={`Move ${p.title} up`}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={busy || i === pages.length - 1}
                    title="Move down"
                    aria-label={`Move ${p.title} down`}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
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

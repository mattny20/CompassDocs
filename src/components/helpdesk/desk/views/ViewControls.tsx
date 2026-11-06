"use client";

// The saved views' controls on the ticket list (1.19.1, agent V4):
//   EditViewButton   the list header's quiet Filter icon button ("Edit view"
//                    on a saved view you may change), opening the filter
//                    dialog with the list's own filters. Icon-only: the
//                    23rem header already holds the title, Sort and New.
//   SaveViewButton   "Save view" on the filtered-list strip.

import { BookmarkPlus, Filter } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import type { QueueSel } from "../queue/views";
import { filtersFromSel, type SavedViews } from "./saved";

export function EditViewButton({ sv, sel }: { sv: SavedViews; sel: QueueSel }) {
  const views = sv.list?.views;
  const view = sel.saved ? views?.find((v) => v.id === sel.saved) ?? null : null;
  const label = view?.can_edit ? "Edit view" : "Filter";
  return (
    <button
      type="button"
      onClick={() => sv.setDialog({ kind: "filter", filters: filtersFromSel(sel, views), view })}
      aria-haspopup="dialog"
      aria-label={view?.can_edit ? `Edit the view ${view.name}` : "Filter tickets"}
      data-tt={label}
      className={iconButtonClass("quiet", "sm")}
    >
      <Filter aria-hidden />
    </button>
  );
}

export function SaveViewButton({ sv, sel }: { sv: SavedViews; sel: QueueSel }) {
  return (
    <button
      type="button"
      onClick={() => sv.setDialog({ kind: "save", filters: filtersFromSel(sel, sv.list?.views) })}
      aria-haspopup="dialog"
      className="link inline-flex shrink-0 items-center gap-1 font-medium"
    >
      <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
      Save view
    </button>
  );
}

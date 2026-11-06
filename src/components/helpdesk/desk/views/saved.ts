"use client";

// Saved queue views on the desk (1.19.1, agent V4): the state the queue
// layout holds (the list with counts, the open dialog) and the helpers that
// turn a queue selection into a view's filters and back.
//
// A saved view's filters are the tickets API's queue parameters, so the
// list for ?saved=12 is GET /api/helpdesk/tickets?<filters>&sort=…, and
// "Save this view" stores exactly what the current list asked the API for.

import { useCallback, useEffect, useState } from "react";
import type { HdSavedView, HdSavedViewsList, HdViewFilters } from "@/lib/helpdesk/saved-views-shared";
import { toast } from "@/components/Toasts";
import { confirmDialog } from "@/components/Dialog";
import { getJson, sendJson } from "../api";
import { apiQs, type QueueSel } from "../queue/views";

/** The filters behind a selection: a saved view's own, else what the list asks the API for (sort aside). */
export function filtersFromSel(sel: QueueSel, views: HdSavedView[] | undefined): HdViewFilters {
  if (sel.saved) {
    const v = views?.find((x) => x.id === sel.saved);
    return v ? { ...v.filters } : {};
  }
  const out: HdViewFilters = {};
  for (const [k, v] of new URLSearchParams(apiQs(sel))) if (k !== "sort" && v) out[k] = v;
  return out;
}

/** The tickets API query for a saved view; null while the views load or when it is gone. */
export function savedApiQs(sel: QueueSel, views: HdSavedView[] | undefined): string | null {
  const v = views?.find((x) => x.id === sel.saved);
  if (!v) return null;
  const p = new URLSearchParams(v.filters);
  p.set("sort", sel.sort);
  return p.toString();
}

/** The queue selection that shows `filters` as a filtered list (from=filter). */
export function filterSel(filters: HdViewFilters, sort: QueueSel["sort"]): QueueSel {
  return { view: null, team: null, saved: null, sort, origin: "filter", drill: { ...filters } };
}

export type ViewDialog =
  | { kind: "save"; filters: HdViewFilters }
  | { kind: "rename"; view: HdSavedView }
  | { kind: "filter"; filters: HdViewFilters; view: HdSavedView | null };

export interface SavedViews {
  list: HdSavedViewsList | null;
  /** The list failed to load (the nav says so quietly). */
  failed: boolean;
  refresh: () => void;
  /** Put a view just saved into the list at once (the next refresh brings its count). */
  add: (v: HdSavedView) => void;
  dialog: ViewDialog | null;
  setDialog: (d: ViewDialog | null) => void;
  /** Ask, then delete; resolves true when deleted. */
  remove: (v: HdSavedView) => Promise<boolean>;
  /** Replace a view's filters ("Use the current list"). */
  setFilters: (v: HdSavedView, filters: HdViewFilters) => Promise<boolean>;
}

/** The saved views with counts, polled every minute while the tab is visible. */
export function useSavedViews(): SavedViews {
  const [list, setList] = useState<HdSavedViewsList | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<ViewDialog | null>(null);

  const refresh = useCallback(() => {
    getJson<HdSavedViewsList>("/api/helpdesk/views", "Couldn't load your saved views.")
      .then((d) => {
        setList({ views: Array.isArray(d.views) ? d.views : [], share_teams: Array.isArray(d.share_teams) ? d.share_teams : [] });
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const remove = useCallback(
    async (v: HdSavedView) => {
      const ok = await confirmDialog({
        title: `Delete the view "${v.name}"?`,
        body: v.team_id ? `Everyone in ${v.team_name ?? "the team"} loses it from their views. The tickets stay as they are.` : "The tickets stay as they are.",
        confirmLabel: "Delete view",
        danger: true,
      });
      if (ok !== true) return false;
      try {
        await sendJson(`/api/helpdesk/views/${v.id}`, "DELETE", undefined, "Couldn't delete the view.");
        toast("ok", `Deleted "${v.name}".`);
        refresh();
        return true;
      } catch (e) {
        toast("error", (e as Error).message);
        return false;
      }
    },
    [refresh]
  );

  const setFilters = useCallback(
    async (v: HdSavedView, filters: HdViewFilters) => {
      try {
        await sendJson(`/api/helpdesk/views/${v.id}`, "PATCH", { filters }, "Couldn't update the view.");
        toast("ok", `Updated "${v.name}".`);
        refresh();
        return true;
      } catch (e) {
        toast("error", (e as Error).message);
        return false;
      }
    },
    [refresh]
  );

  const add = useCallback((v: HdSavedView) => {
    setList((l) => (l ? { ...l, views: [...l.views.filter((x) => x.id !== v.id), v] } : { views: [v], share_teams: [] }));
  }, []);

  return { list, failed, refresh, add, dialog, setDialog, remove, setFilters };
}

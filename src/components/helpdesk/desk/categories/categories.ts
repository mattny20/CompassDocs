"use client";

// The desk admin's list of categories and sub-categories (1.20.6,
// lib/helpdesk/categories) as the desk's pickers need it: the ticket side
// panel, the Filter dialog, the request type and automation editors and
// Before you solve. One read per page load, shared by every caller; the
// Categories settings page forgets it after a change, and everything that
// is mounted reads it again.

import { useEffect, useState } from "react";
import type { HdCategory } from "@/lib/helpdesk/categories-shared";
import { getJson } from "../api";

export interface DeskCategories {
  /** Every entry, archived ones marked. null until loaded. */
  list: HdCategory[] | null;
  /** The caller may open Desk settings → Categories. */
  canManage: boolean;
}

/** Where an admin manages the list. */
export const CATEGORIES_SETTINGS_HREF = "/desk/settings/categories";

const EMPTY: DeskCategories = { list: null, canManage: false };
let cache: Promise<DeskCategories> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<DeskCategories> {
  cache ??= getJson<{ categories?: HdCategory[]; can_manage?: boolean }>("/api/helpdesk/categories")
    .then((d) => ({ list: Array.isArray(d?.categories) ? d.categories : [], canManage: d?.can_manage === true }))
    .catch(() => {
      cache = null;
      return { list: [], canManage: false };
    });
  return cache;
}

/** Forget the list (the Categories settings page changed it); mounted pickers read it again. */
export function forgetDeskCategories(): void {
  cache = null;
  for (const l of listeners) l();
}

/** The list (`list` is null until it has loaded). */
export function useDeskCategories(): DeskCategories {
  const [state, setState] = useState<DeskCategories>(EMPTY);
  useEffect(() => {
    let live = true;
    const read = () => void load().then((d) => live && setState(d));
    read();
    listeners.add(read);
    return () => {
      live = false;
      listeners.delete(read);
    };
  }, []);
  return state;
}

/** The entries a picker offers: nothing archived. */
export function pickable(list: HdCategory[] | null): HdCategory[] {
  return (list ?? []).filter((c) => !c.archived).map((c) => ({ ...c, subcategories: c.subcategories.filter((s) => !s.archived) }));
}

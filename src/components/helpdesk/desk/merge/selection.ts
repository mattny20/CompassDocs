"use client";

// Row selection for the queue's bulk bar (1.19.1, agent V2). Selection is
// per list: it holds ticket numbers and drops any that leave the list (a
// new view, a reload). Shift-click selects the range from the last row
// clicked; x toggles the row under keyboard focus (QueueLayout binds it
// through useDeskKeys, so the single-key preference covers it).

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { HdTicketListRow } from "@/lib/helpdesk/types";

export interface RowSelection {
  selected: ReadonlySet<number>;
  count: number;
  rows: HdTicketListRow[];
  has: (number: number) => boolean;
  /** Flip one row; with `range`, set every row from the last one clicked to this one. */
  toggle: (number: number, range?: boolean) => void;
  /** Select every row shown, or none when all are. */
  toggleAll: () => void;
  clear: () => void;
  /** x: the row whose link has keyboard focus. */
  toggleFocused: (list: RefObject<HTMLElement | null>) => void;
}

export function useRowSelection(rows: HdTicketListRow[] | null): RowSelection {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    if (!rows) return;
    const live = new Set(rows.map((r) => r.number));
    setSelected((prev) => {
      const next = new Set([...prev].filter((n) => live.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggle = useCallback(
    (number: number, range = false) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const list = rows ?? [];
        const from = anchor.current === null ? -1 : list.findIndex((r) => r.number === anchor.current);
        const to = list.findIndex((r) => r.number === number);
        if (range && from >= 0 && to >= 0) {
          // The range takes the state the last row clicked was left in.
          const on = prev.has(anchor.current!);
          for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
            if (on) next.add(list[i].number);
            else next.delete(list[i].number);
          }
        } else if (next.has(number)) next.delete(number);
        else next.add(number);
        return next;
      });
      anchor.current = number;
    },
    [rows]
  );

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const list = rows ?? [];
      return list.length > 0 && list.every((r) => prev.has(r.number)) ? new Set() : new Set(list.map((r) => r.number));
    });
  }, [rows]);

  const toggleFocused = useCallback(
    (list: RefObject<HTMLElement | null>) => {
      const el = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-number]") : null;
      if (!el || !list.current?.contains(el)) return;
      const n = Number(el.dataset.number);
      if (Number.isInteger(n)) toggle(n);
    },
    [toggle]
  );

  const chosen = useMemo(() => (rows ?? []).filter((r) => selected.has(r.number)), [rows, selected]);
  return {
    selected,
    count: chosen.length,
    rows: chosen,
    has: (n) => selected.has(n),
    toggle,
    toggleAll,
    clear,
    toggleFocused,
  };
}

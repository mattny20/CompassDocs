"use client";

// The read-only parent of a workflow task (GET /api/helpdesk/tickets/
// [number]/workflow-context), loaded once per ticket and shared by the
// components a task ticket mounts (the outcome bar, the Part of request
// card), so a ticket pane asks for it once. `refreshWorkflowContext(n)`
// drops the cached copy and tells every mounted reader to load again
// (after Mark done or Can't be done).

import { useCallback, useEffect, useState } from "react";
import { ApiError, getJson, itemOf } from "../api";
import type { HdWorkflowContext } from "./contract";

const cache = new Map<number, Promise<HdWorkflowContext>>();
const EVENT = "hd:workflow-context";

export function loadWorkflowContext(number: number): Promise<HdWorkflowContext> {
  let p = cache.get(number);
  if (!p) {
    // The route answers { context: {...} }; accept the bare object too.
    p = getJson(`/api/helpdesk/tickets/${number}/workflow-context`, "Couldn't load the request this task belongs to.").then((d) =>
      itemOf<HdWorkflowContext>(d, "context")
    );
    p.catch(() => cache.delete(number));
    cache.set(number, p);
  }
  return p;
}

export function refreshWorkflowContext(number: number) {
  cache.delete(number);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: { number } }));
}

export function useWorkflowContext(number: number | null) {
  const [ctx, setCtx] = useState<HdWorkflowContext | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!number) return;
    let live = true;
    loadWorkflowContext(number)
      .then((c) => {
        if (!live) return;
        setCtx(c);
        setError(null);
      })
      .catch((e: unknown) => live && setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [number, tick]);

  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ number: number }>).detail?.number === number) setTick((t) => t + 1);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [number]);

  const reload = useCallback(() => number && refreshWorkflowContext(number), [number]);
  return { ctx, error, reload };
}

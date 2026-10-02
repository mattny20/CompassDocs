"use client";

// Row actions that cannot double-fire and never fail silently (STYLEGUIDE
// §Feedback). `run()` ignores re-entry while an action is in flight, shows
// the server's own `error` or a specific fallback sentence when it fails,
// toasts the success line when given one, and keeps the row busy until
// the refreshed page has committed — so a Delete button cannot be clicked
// twice and a Restore does not flicker back for a frame.
//
//   const { run, isBusy, busy } = useAction();
//   <button disabled={isBusy(row.id)} onClick={() => run(row.id,
//     () => fetch(`/api/things/${row.id}`, { method: "DELETE" }),
//     { fallback: "Couldn't delete that thing.", ok: "Thing deleted." })}>

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toasts";

export interface RunOptions {
  /** Shown when the server sends no `error` field, or the request throws. */
  fallback: string;
  /** Success toast. */
  ok?: string;
  /** Refresh the route after success (default true). */
  refresh?: boolean;
}

export type ActionKey = string | number;

export function useAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<ActionKey | null>(null);
  const lastKey = useRef<ActionKey | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (key: ActionKey, fn: () => Promise<Response | void>, opts: RunOptions): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      lastKey.current = key;
      setBusyKey(key);
      try {
        const res = await fn();
        if (res instanceof Response && !res.ok) {
          const data = await res.json().catch(() => ({}));
          toast("error", (data as { error?: string })?.error || opts.fallback);
          return false;
        }
        if (opts.ok) toast("ok", opts.ok);
        if (opts.refresh !== false) startTransition(() => router.refresh());
        return true;
      } catch {
        toast("error", opts.fallback);
        return false;
      } finally {
        inFlight.current = false;
        setBusyKey(null);
      }
    },
    [router]
  );

  const busy = busyKey !== null || pending;
  const isBusy = useCallback(
    (key: ActionKey) => busyKey === key || (pending && lastKey.current === key),
    [busyKey, pending]
  );

  return { run, busy, isBusy, busyKey };
}

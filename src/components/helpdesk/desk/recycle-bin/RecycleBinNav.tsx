"use client";

// The Views nav's "Recycle bin" row (1.19.4, area C7; mock-ups v1-v3): a
// house rail row with Trash2 and the number of tickets in the bin that this
// person sees, shown only to desk roles holding tickets.delete. It opens
// /desk/recycle-bin; the count reloads with the desk counts and after any
// delete, restore or purge (./actions BIN_CHANGED).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { railIconClass, railRowClass } from "@/components/RailLink";
import { getJson } from "../api";
import { useCan } from "../me";
import { BIN_CHANGED } from "./actions";

export function RecycleBinNav({ refreshKey, onPick, asMenu = false }: { refreshKey?: unknown; onPick?: () => void; asMenu?: boolean }) {
  const can = useCan();
  const allowed = can("tickets.delete");
  const path = usePathname() ?? "";
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    const load = () =>
      getJson<{ count: number | null }>("/api/helpdesk/recycle-bin?count=1")
        .then((r) => live && setCount(r.count))
        .catch(() => {
          /* the row still works without its count */
        });
    void load();
    window.addEventListener(BIN_CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(BIN_CHANGED, load);
    };
  }, [allowed, refreshKey]);

  if (!allowed) return null;
  const on = path.startsWith("/desk/recycle-bin");
  return (
    <div className="mt-4" data-testid="recycle-bin-nav">
      <Link href="/desk/recycle-bin" onClick={onPick} role={asMenu ? "menuitem" : undefined} aria-current={on ? "page" : undefined} className={railRowClass(on)}>
        <Trash2 className={`h-4 w-4 ${railIconClass(on)}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">Recycle bin</span>
        {count !== null && (
          <span className="text-xs tabular-nums text-slate-500">
            {count}
            <span className="sr-only"> deleted tickets</span>
          </span>
        )}
      </Link>
    </div>
  );
}

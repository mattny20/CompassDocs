"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  const [spinning, setSpinning] = useState(false);
  return (
    <button
      onClick={() => {
        setSpinning(true);
        router.refresh();
        setTimeout(() => setSpinning(false), 600);
      }}
      className="rounded-lg border border-slate-200 bg-surface px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
    >
      {spinning ? "Refreshing…" : "↻ Refresh"}
    </button>
  );
}

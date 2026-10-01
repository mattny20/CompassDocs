"use client";

import { useState } from "react";
import { buttonClass } from "@/components/Button";
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
      className={buttonClass("secondary")}
    >
      {spinning ? "Refreshing…" : "↻ Refresh"}
    </button>
  );
}

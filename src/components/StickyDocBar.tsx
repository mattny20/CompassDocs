"use client";

// Compact bar that fades in at the top of the content area once the document
// masthead scrolls out of view, keeping the title and actions reachable in
// long documents. Rendered as a zero-height sticky element so it takes no
// space in the flow; visibility is driven by a sentinel just above it.

import { useEffect, useRef, useState } from "react";

export function StickyDocBar({ children }: { children: React.ReactNode }) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      threshold: 0,
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px" />
      <div className="sticky top-0 z-20 h-0 print:hidden">
        <div
          className={`flex items-center gap-3 rounded-b-xl border-x border-b border-slate-200 bg-surface/95 px-4 py-2 shadow-sm backdrop-blur transition-all duration-200 ${
            stuck ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0"
          }`}
        >
          {children}
        </div>
      </div>
    </>
  );
}

"use client";

// Collapse state for doc side-panel sections, remembered per browser. The
// default is "open when there's content, tucked away when empty" — a user's
// explicit choice then sticks.

import { useEffect, useState } from "react";

export function usePanelCollapse(key: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`docpanel:${key}`);
      if (saved === "1") setOpen(true);
      if (saved === "0") setOpen(false);
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(`docpanel:${key}`, v ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !v;
    });
  };
  return [open, toggle];
}

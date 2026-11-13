"use client";

// The calendar print preview's toolbar (1.20.6): back to the Calendar and
// "Print or save as PDF". Never printed. `?print=1` (the Calendar page's
// Print) opens the browser's dialog once the page has settled, then drops
// the flag so a reload does not print again.

import { useEffect, useRef } from "react";
import { Printer } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/Button";

export function PrintCalendarToolbar({ back, what, landscape, autoPrint }: { back: string; what: string; landscape: boolean; autoPrint: boolean }) {
  const printed = useRef(false);
  useEffect(() => {
    if (!autoPrint || printed.current) return;
    printed.current = true;
    let cancelled = false;
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (cancelled) return;
      const next = new URLSearchParams(window.location.search);
      next.delete("print");
      const qs = next.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
      window.print();
    });
    return () => {
      cancelled = true;
      printed.current = false;
    };
  }, [autoPrint]);

  return (
    <header className={`w-full print:hidden ${landscape ? "max-w-[297mm]" : "max-w-[210mm]"}`}>
      <PageHeader
        className=""
        icon={<Printer />}
        title="Print preview"
        back={{ href: back, label: "Calendar" }}
        subtitle={`${what} Headers, footers and page numbers are added on paper.`}
        actions={
          <Button icon={<Printer />} onClick={() => window.print()}>
            Print or save as PDF
          </Button>
        }
      />
    </header>
  );
}

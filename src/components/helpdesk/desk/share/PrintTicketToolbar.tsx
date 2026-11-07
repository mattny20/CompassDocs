"use client";

// The ticket print preview's toolbar (1.19.4, area C6): back to the ticket
// and "Print or save as PDF". Never printed. `?print=1` (the print
// dialog's Print) opens the browser's dialog once the page has settled,
// then drops the flag so a reload does not print again. The audit row is
// the server's: the page writes it as it renders (lib/helpdesk/share
// recordPrintView), so nothing here reports what was printed.

import { useEffect, useRef } from "react";
import { Printer } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/Button";

async function settled(): Promise<void> {
  await document.fonts?.ready;
  const pending = Array.from(document.images).filter((img) => !img.complete);
  await Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((done) => {
          img.addEventListener("load", () => done(), { once: true });
          img.addEventListener("error", () => done(), { once: true });
        })
    )
  );
}

export function PrintTicketToolbar({ number, notes, autoPrint }: { number: number; notes: boolean; autoPrint: boolean }) {
  const printed = useRef(false);

  useEffect(() => {
    if (!autoPrint || printed.current) return;
    printed.current = true;
    let cancelled = false;
    void settled().then(() => {
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
    <header className="w-full max-w-[210mm] print:hidden">
      <PageHeader
        className=""
        icon={<Printer />}
        title="Print preview"
        back={{ href: `/desk/tickets/${number}`, label: `Ticket #${number}` }}
        subtitle={`Headers, footers and page numbers are added on paper. Internal notes ${notes ? "are" : "aren't"} included.`}
        actions={
          <Button icon={<Printer />} onClick={() => window.print()}>
            Print or save as PDF
          </Button>
        }
      />
    </header>
  );
}

"use client";

// The print preview's toolbar (1.18.0): back to the handbook, the paper
// size (A4 or Letter: the @page size, so the browser's dialog follows it),
// and "Print or save as PDF". Never printed.
//
// Two behaviours live here because they need the browser:
// - `?print=1` (the reader's and the list's print links) opens the print
//   dialog once the page has settled (fonts, images), then drops the flag
//   from the address so a reload does not print again;
// - every print of this page, from the button, the dialog link or the
//   browser's own Ctrl+P, records handbook.printed. `beforeprint` is the one
//   event all three raise; a repeat within a few seconds is the same print.

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/Button";
import { Segmented } from "@/components/Segmented";
import type { PaperSize } from "./print-model";

const REPEAT_MS = 5000;

/** Resolves once web fonts and the images already in the page have loaded (or failed). */
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

export function PrintToolbar({
  handbookId,
  title,
  paper,
  autoPrint,
}: {
  handbookId: number;
  title: string;
  paper: PaperSize;
  autoPrint: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const lastAudit = useRef(0);
  const printed = useRef(false);

  useEffect(() => {
    function onBeforePrint() {
      const now = Date.now();
      if (now - lastAudit.current < REPEAT_MS) return;
      lastAudit.current = now;
      // keepalive: the dialog can outlive a navigation away.
      void fetch(`/api/handbooks/${handbookId}/printed`, { method: "POST", keepalive: true }).catch(() => {});
    }
    window.addEventListener("beforeprint", onBeforePrint);
    return () => window.removeEventListener("beforeprint", onBeforePrint);
  }, [handbookId]);

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
      // Unmounted before the page settled (or React's dev double-run):
      // the next mount starts over.
      cancelled = true;
      printed.current = false;
    };
  }, [autoPrint]);

  function choosePaper(next: PaperSize) {
    const qs = new URLSearchParams(params.toString());
    qs.delete("print");
    qs.set("paper", next);
    router.replace(`${pathname}?${qs.toString()}`, { scroll: false });
  }

  // The page's h1 is this header's "Print preview" (STYLEGUIDE §Page
  // skeleton); the cover's title is the first sheet's own heading.
  return (
    <header className={`w-full print:hidden ${paper === "letter" ? "max-w-[8.5in]" : "max-w-[210mm]"}`}>
      <PageHeader
        className=""
        icon={<Printer />}
        title="Print preview"
        back={{ href: `/handbooks/${handbookId}`, label: title }}
        subtitle="Headers, footers and page numbers are added on paper."
        actions={
          <>
            <Segmented<PaperSize>
              label="Paper size"
              size="sm"
              value={paper}
              onChange={choosePaper}
              options={[
                { value: "a4", label: "A4" },
                { value: "letter", label: "Letter" },
              ]}
            />
            <Button icon={<Printer />} onClick={() => window.print()}>
              Print or save as PDF
            </Button>
          </>
        }
      />
    </header>
  );
}

"use client";

// The Read confirmation pages are two jobs (1.10.0): Record (who has
// confirmed which version) and History (every keep and every reset, by whom
// and why). This row switches between them under the shared header, the way
// the directory settings do; a later release adds Settings. It is a client
// component only because icon components cannot cross from the server
// layout into the shared SubNav. Hidden on paper: the Record is printed as
// evidence, and a navigation row is a control (STYLEGUIDE §Print).

import { ClipboardList, History } from "lucide-react";
import { SubNav } from "@/components/SubNav";

export function AckSubnav({ docId }: { docId: number }) {
  const base = `/doc/${docId}/acknowledgements`;
  return (
    <SubNav
      label="Read confirmation"
      className="print:hidden"
      items={[
        { href: base, label: "Record", icon: ClipboardList },
        { href: `${base}/history`, label: "History", icon: History },
      ]}
    />
  );
}

"use client";

// The Read confirmation pages are three jobs: Record (who has confirmed
// which version), History (every keep and every reset, by whom and why) and,
// for those who may change how the policy asks (document.ack_require on the
// space, or the program manager), Settings (C2, 1.12.0: the confirmation
// statement and the typed signature; wave 2 adds re-confirmation and the
// lifecycle). This row switches between them under the shared header, the
// way the directory settings do. It is a client component only because
// icon components cannot cross from the server layout into the shared
// SubNav. Hidden on paper: the Record is printed as evidence, and a
// navigation row is a control (STYLEGUIDE §Print).

import { ClipboardList, History, Settings2 } from "lucide-react";
import { SubNav } from "@/components/SubNav";

export function AckSubnav({ docId, showSettings = false }: { docId: number; showSettings?: boolean }) {
  const base = `/doc/${docId}/acknowledgements`;
  return (
    <SubNav
      label="Read confirmation"
      className="print:hidden"
      items={[
        { href: base, label: "Record", icon: ClipboardList },
        { href: `${base}/history`, label: "History", icon: History },
        ...(showSettings ? [{ href: `${base}/settings`, label: "Settings", icon: Settings2 }] : []),
      ]}
    />
  );
}

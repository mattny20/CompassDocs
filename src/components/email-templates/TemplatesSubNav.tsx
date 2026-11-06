"use client";

// The tab row under Email templates (1.19.0): the compositions, then the
// four part libraries. Routed pages, so they are the house SubNav (links
// with aria-current), never a tablist. Client-side because icon components
// cannot cross from a server layout.

import { FileText, LayoutTemplate, PanelBottom, PanelTop, Signature } from "lucide-react";
import { SubNav } from "@/components/SubNav";

export function TemplatesSubNav({ base, className = "" }: { base: string; className?: string }) {
  return (
    <SubNav
      label="Email template libraries"
      root={base}
      className={className}
      items={[
        { href: base, label: "Templates", icon: LayoutTemplate },
        { href: `${base}/headers`, label: "Headers", icon: PanelTop },
        { href: `${base}/bodies`, label: "Bodies", icon: FileText },
        { href: `${base}/signatures`, label: "Signatures", icon: Signature },
        { href: `${base}/footers`, label: "Footers", icon: PanelBottom },
      ]}
    />
  );
}

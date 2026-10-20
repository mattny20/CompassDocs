"use client";

// The Compliance section's pages (B4, 1.12.0): My policies for everyone
// the sidebar shows the section to, then the portal's Overview, Policies
// and People for compliance.program_read holders and Settings for
// program_manage holders. The layout decides which tabs the viewer may
// open; this row only draws them. A client component because icon
// components cannot cross from the server layout into the shared SubNav
// (the Read confirmation pages' AckSubnav does the same). Hidden on paper:
// a navigation row is a control (STYLEGUIDE §Print).

import { ChartColumn, ClipboardCheck, FileCheck, Settings2, Users } from "lucide-react";
import { SubNav, type SubNavItem } from "@/components/SubNav";

export function ComplianceSubNav({ section, settings }: { section: boolean; settings: boolean }) {
  const items: SubNavItem[] = [{ href: "/compliance", label: "My policies", icon: ClipboardCheck }];
  if (section) {
    items.push(
      { href: "/compliance/overview", label: "Overview", icon: ChartColumn },
      { href: "/compliance/policies", label: "Policies", icon: FileCheck },
      { href: "/compliance/people", label: "People", icon: Users }
    );
  }
  if (settings) items.push({ href: "/compliance/settings", label: "Settings", icon: Settings2 });
  return <SubNav label="Compliance" items={items} root="/compliance" className="print:hidden" />;
}

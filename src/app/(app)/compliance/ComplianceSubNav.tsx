"use client";

// The Compliance section's pages (B4, 1.12.0): My policies for everyone
// the sidebar shows the section to, then the portal's Overview, Policies
// and People for compliance.program_read holders and Settings for
// program_manage holders. The layout decides which tabs the viewer may
// open; this row only draws them. A client component because icon
// components cannot cross from the server layout into the shared SubNav
// (the Read confirmation pages' AckSubnav does the same). Hidden on paper:
// a navigation row is a control (STYLEGUIDE §Print).

import { ChartColumn, ClipboardCheck, FileCheck, Layers, Settings2, ShieldCheck, Users, UsersRound } from "lucide-react";
import { SubNav, type SubNavItem } from "@/components/SubNav";

export function ComplianceSubNav({
  section,
  evidence = false,
  team = false,
  settings,
}: {
  section: boolean;
  /** Evidence (F2, 1.14.0): compliance.export holders. */
  evidence?: boolean;
  /** Team (F4, 1.14.0): group leads when Program settings let them see policy standing, and compliance.team_read holders. */
  team?: boolean;
  settings: boolean;
}) {
  const items: SubNavItem[] = [{ href: "/compliance", label: "My policies", icon: ClipboardCheck }];
  if (section) {
    items.push(
      { href: "/compliance/overview", label: "Overview", icon: ChartColumn },
      { href: "/compliance/policies", label: "Policies", icon: FileCheck },
      { href: "/compliance/people", label: "People", icon: Users },
      { href: "/compliance/sets", label: "Sets", icon: Layers }
    );
  }
  // Evidence (F2, 1.14.0): after Sets, before Team and Settings.
  if (evidence) items.push({ href: "/compliance/evidence", label: "Evidence", icon: ShieldCheck });
  // Team (F4, 1.14.0): a lead's own tab, whether or not they hold the section; after Evidence, before Settings.
  if (team) items.push({ href: "/compliance/team", label: "Team", icon: UsersRound });
  if (settings) items.push({ href: "/compliance/settings", label: "Settings", icon: Settings2 });
  return <SubNav label="Compliance" items={items} root="/compliance" className="print:hidden" />;
}

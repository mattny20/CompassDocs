// The dashboard's Quick links tile (1.17.0, key "quick_links"): the
// viewer's own pins, the links an admin featured on everyone's dashboard,
// and the viewer's most-used links over the last 30 days (topped up with
// the workspace's when they have few clicks). The data and its
// de-duplication come from lib/quick-links; the tile itself is client-side
// (QuickLinksClient) because pinning, the Add dialog and the edit mode
// update it optimistically. Always renders: with nothing in it, it is an
// invitation to pin the first link.

import type { SessionUser } from "@/lib/types";
import { getDashboardQuickLinks, listPinnableLinks } from "@/lib/quick-links";
import { QuickLinksClient } from "./QuickLinksClient";
import { helpTrigger } from "@/components/helpdesk/help/trigger-server";

export async function QuickLinksTile({ user }: { user: SessionUser }) {
  const [links, pinnable, broken] = await Promise.all([
    getDashboardQuickLinks(user),
    listPinnableLinks(user),
    // "This link is broken" (Helpdesk 1.19.0) on curated links, when the person may raise a request.
    helpTrigger(user, "link"),
  ]);
  return (
    <QuickLinksClient
      pinned={links.pinned}
      featured={links.featured}
      mostUsed={links.mostUsed}
      mostUsedIsWorkspace={links.mostUsedIsWorkspace}
      pinnable={pinnable}
      brokenLink={broken}
    />
  );
}

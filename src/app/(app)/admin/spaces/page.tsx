import { listSpaces, listGroups, listAllSpaceGroups, listAllSpaceSubscriptionGroups } from "@/lib/db";
import { SpacesManager } from "@/components/SpacesManager";

export const dynamic = "force-dynamic";

export default async function SpacesPage() {
  const [spaces, groups, spaceGroups, subscriptionGroups] = await Promise.all([
    listSpaces(),
    listGroups(),
    listAllSpaceGroups(),
    listAllSpaceSubscriptionGroups(),
  ]);
  return (
    <SpacesManager
      initial={spaces}
      groups={groups.map((g) => ({
        id: g.id,
        name: g.name,
        source: g.source,
        member_count: g.member_count,
      }))}
      initialSpaceGroups={spaceGroups}
      initialSubscriptionGroups={subscriptionGroups}
    />
  );
}

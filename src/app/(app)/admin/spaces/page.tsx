import {
  listSpaces,
  listGroups,
  listUsers,
  listAllSpaceGroups,
  listAllSpaceSubscriptionGroups,
  listAllSpaceEditorGrants,
} from "@/lib/db";
import { editorsEditAll } from "@/lib/access";
import { roleAtLeast } from "@/lib/types";
import { SpacesManager } from "@/components/SpacesManager";

export const dynamic = "force-dynamic";

export default async function SpacesPage() {
  const [spaces, groups, users, spaceGroups, subscriptionGroups, editorGrants, editAll] =
    await Promise.all([
      listSpaces(),
      listGroups(),
      listUsers(),
      listAllSpaceGroups(),
      listAllSpaceSubscriptionGroups(),
      listAllSpaceEditorGrants(),
      editorsEditAll(),
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
      // Only editor+ accounts make sense as per-space editors (admins bypass).
      users={users
        .filter((u) => u.status === "active" && roleAtLeast(u.role, "editor") && u.role !== "admin")
        .map((u) => ({ id: u.id, name: u.name || u.username, role: u.role }))}
      initialSpaceGroups={spaceGroups}
      initialSubscriptionGroups={subscriptionGroups}
      initialEditorGrants={editorGrants}
      initialEditorsEditAll={editAll}
    />
  );
}

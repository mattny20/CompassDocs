import {
  listSpaces,
  listGroups,
  listUsers,
  listAllSpaceGroups,
  listAllSpaceSubscriptionGroups,
  listAllSpaceEditorGrants,
  listAllSpaceCategories,
} from "@/lib/db";
import { editorsEditAll } from "@/lib/access";
import { listTemplates } from "@/lib/doc-templates";
import { roleAtLeast } from "@/lib/types";
import { SpacesManager } from "@/components/SpacesManager";

export const dynamic = "force-dynamic";

export default async function SpacesPage() {
  const [spaces, groups, users, spaceGroups, subscriptionGroups, editorGrants, editAll, cats, templates] =
    await Promise.all([
      listSpaces(),
      listGroups(),
      listUsers(),
      listAllSpaceGroups(),
      listAllSpaceSubscriptionGroups(),
      listAllSpaceEditorGrants(),
      editorsEditAll(),
      listAllSpaceCategories(),
      listTemplates(true),
    ]);
  const categoriesBySpace: Record<number, { id: number; name: string; position: number }[]> = {};
  for (const c of cats) (categoriesBySpace[c.space_id] ??= []).push({ id: c.id, name: c.name, position: c.position });
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
      templates={templates.map((t) => ({ id: t.id, name: t.name, hidden: t.hidden === 1 }))}
      initialSpaceGroups={spaceGroups}
      initialSubscriptionGroups={subscriptionGroups}
      initialEditorGrants={editorGrants}
      initialEditorsEditAll={editAll}
      initialCategories={categoriesBySpace}
    />
  );
}

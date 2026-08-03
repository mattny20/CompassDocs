import { requireSettingsSection } from "@/lib/auth";
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
import { SpacesManager } from "@/components/SpacesManager";
import { SettingsPage } from "@/components/SettingsPage";
import { EVERY_SPACE_UNFILTERED } from "@/lib/space-scope";

export const dynamic = "force-dynamic";

export default async function SpacesPage() {
  await requireSettingsSection("/admin/spaces");
  const [spaces, groups, users, spaceGroups, subscriptionGroups, editorGrants, editAll, cats, templates] =
    await Promise.all([
      listSpaces(EVERY_SPACE_UNFILTERED),
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
    <SettingsPage href="/admin/spaces">
    <SpacesManager
      initial={spaces}
      groups={groups.map((g) => ({
        id: g.id,
        name: g.name,
        source: g.source,
        member_count: g.member_count,
      }))}
      // Every active account, because a per-space grant now confers authoring
      // on its own (1.0). Filtering this list to editor+ was correct while a
      // grant only *unlocked* rights the rung already carried; it now prevents
      // the exact thing the grant exists to do — give one person authoring in
      // one space without promoting them everywhere.
      users={users
        .filter((u) => u.status === "active")
        .map((u) => ({ id: u.id, name: u.name || u.username, role: u.role }))}
      templates={templates.map((t) => ({ id: t.id, name: t.name, hidden: t.hidden === 1 }))}
      initialSpaceGroups={spaceGroups}
      initialSubscriptionGroups={subscriptionGroups}
      initialEditorGrants={editorGrants}
      initialEditorsEditAll={editAll}
      initialCategories={categoriesBySpace}
    />
    </SettingsPage>
  );
}

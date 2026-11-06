// /desk/settings/*: the desk's configuration, a settings rail beside the
// page. The rail shows the pages the person's desk role reaches; each page
// checks its own capability too. 1.19.2 (agent W5, lib/helpdesk/whats-new):
// what this person has not seen yet (the rail's New chips, the release
// strip) is read here and shared with the rail and the pages.

import { requireUser } from "@/lib/auth";
import { DeskSettingsNav } from "@/components/helpdesk/desk/settings/DeskSettingsNav";
import { DeskNewProvider } from "@/components/helpdesk/desk/settings/DeskNew";
import { settingsItems } from "@/components/helpdesk/desk/settings/settings-nav";
import { deskNewState } from "@/lib/helpdesk/whats-new";
import { deskRoleCaps } from "../../desk-access";

export default async function DeskSettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const role = await deskRoleCaps(user);
  const fresh = await deskNewState(
    user.id,
    settingsItems(role.caps).flatMap((g) => g.items.map((i) => i.href))
  );
  return (
    <DeskNewProvider initial={fresh}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <DeskSettingsNav caps={role.caps} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </DeskNewProvider>
  );
}

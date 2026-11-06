// /desk/settings/*: the desk's configuration, a settings rail beside the
// page. The rail shows the pages the person's desk role reaches; each page
// checks its own capability too.

import { requireUser } from "@/lib/auth";
import { DeskSettingsNav } from "@/components/helpdesk/desk/settings/DeskSettingsNav";
import { deskRoleCaps } from "../../desk-access";

export default async function DeskSettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const role = await deskRoleCaps(user);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      <DeskSettingsNav caps={role.caps} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

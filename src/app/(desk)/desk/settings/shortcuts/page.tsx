// /desk/settings/shortcuts: Shortcuts (desk settings, 1.19.1). The request
// type each CompassDocs shortcut opens, or Hidden. Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access: settings.manage).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ShortcutsSettings } from "@/components/helpdesk/desk/settings/ShortcutsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shortcuts" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "shortcuts"))) return <DeskPageForbidden what="Shortcuts" />;
  return <ShortcutsSettings />;
}

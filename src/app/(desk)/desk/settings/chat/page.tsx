// /desk/settings/chat: moved under Integrations in 1.20.2. The old address
// still answers: after sign-in and the page's own capability check it
// sends the person to the new place (MOVED_SETTINGS), so bookmarks, old
// notifications and links in tickets keep working.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { MOVED_SETTINGS } from "@/lib/helpdesk/integrations-hub-shared";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "chat"))) return <DeskPageForbidden what="Chat apps" />;
  redirect(MOVED_SETTINGS["/desk/settings/chat"] ?? "/desk/settings/integrations/chat");
}

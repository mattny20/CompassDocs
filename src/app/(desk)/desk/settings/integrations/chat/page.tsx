// /desk/settings/integrations/chat (until 1.20.2: /desk/settings/chat): Chat apps (desk settings, 1.19.4; mock-up f1). Microsoft
// Teams and Slack: the admin's own bot or app (credentials stored encrypted),
// the address to paste into it, Test, what people can do in each, and the
// channels that open tickets. Opens for a desk role holding settings.manage
// (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ChatAppsSettings } from "@/components/helpdesk/desk/chat/ChatAppsSettings";
import { canOpenSettings } from "../../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat apps" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "chat"))) return <DeskPageForbidden what="Chat apps" />;
  return <ChatAppsSettings />;
}

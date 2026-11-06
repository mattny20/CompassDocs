// /desk/settings/email: Email (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { EmailSettings } from "@/components/helpdesk/desk/settings/EmailSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "email"))) return <DeskPageForbidden what="Email" />;
  return <EmailSettings />;
}

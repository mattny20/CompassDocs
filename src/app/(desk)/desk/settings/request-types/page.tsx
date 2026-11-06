// /desk/settings/request-types: Request types (desk settings). Opens for a desk role that
// holds the page's capability (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { RequestTypesSettings } from "@/components/helpdesk/desk/settings/RequestTypesSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Request types" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "request-types"))) return <DeskPageForbidden what="Request types" />;
  return <RequestTypesSettings />;
}

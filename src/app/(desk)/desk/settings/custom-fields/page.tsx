// /desk/settings/custom-fields: Custom fields (desk settings, 1.20.6,
// lib/helpdesk/custom-fields). The fields a desk admin adds to tickets, each
// assigned to teams and marked Agent only or Public.
// Opens for a desk role holding settings.manage (SETTINGS_CAP in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { CustomFieldsSettings } from "@/components/helpdesk/desk/custom-fields/CustomFieldsSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Custom fields" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "custom-fields"))) return <DeskPageForbidden what="Custom fields" />;
  return <CustomFieldsSettings />;
}

// /desk/settings/categories: Categories (desk settings, 1.20.6, lib/helpdesk/categories).
// The list of categories and sub-categories agents pick on a ticket: add, rename,
// reorder, archive, merge and delete. Opens for a desk role holding settings.manage
// (SETTINGS_CAP in desk-access), as Before you solve does.

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { CategoriesSettings } from "@/components/helpdesk/desk/categories/CategoriesSettings";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Categories" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "categories"))) return <DeskPageForbidden what="Categories" />;
  return <CategoriesSettings />;
}

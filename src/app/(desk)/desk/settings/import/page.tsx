// /desk/settings/import: Import (desk settings, Helpdesk 1.19.1, agent V7).
// Tickets from a Zoho Desk export or a CSV file in four steps: upload, map,
// dry run, import. Opens for a desk role holding settings.manage (the API
// checks the same).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { ImportWizard } from "@/components/helpdesk/desk/settings/import/ImportWizard";
import { canOpenSettings } from "../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "import"))) return <DeskPageForbidden what="Import" />;
  return <ImportWizard />;
}

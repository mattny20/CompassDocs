// /desk/settings/integrations/snipe-it: the Snipe-IT asset source (1.19.3; its own page since 1.20.2).
// Opens for a desk role holding the capability the page always needed
// (SETTINGS_CAP "assets" in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SnipeItSettings } from "@/components/helpdesk/desk/assets/AssetSettings";
import { canOpenSettings } from "../../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Snipe-IT" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "assets"))) return <DeskPageForbidden what="Snipe-IT" />;
  return <SnipeItSettings />;
}

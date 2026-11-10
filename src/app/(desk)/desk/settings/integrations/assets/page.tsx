// /desk/settings/integrations/assets: what holds for every asset source: who sees assets (1.20.2).
// Opens for a desk role holding the capability the page always needed
// (SETTINGS_CAP "assets" in desk-access).

import { requireUser } from "@/lib/auth";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { AssetAccessSettings } from "@/components/helpdesk/desk/assets/AssetSettings";
import { canOpenSettings } from "../../../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Asset settings" };

export default async function Page() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "assets"))) return <DeskPageForbidden what="Asset settings" />;
  return <AssetAccessSettings />;
}

import { RolesPage } from "../_panel";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/roles", "Explain access");

export default function Page() {
  return <RolesPage tab="explain" />;
}

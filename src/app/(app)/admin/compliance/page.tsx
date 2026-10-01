import { redirect } from "next/navigation";

import { settingsMetadata } from "@/lib/settings-sections";

export const metadata = settingsMetadata("/admin/compliance");
// Compliance moved to the main navigation (0.50) — keep old links working.
export default function MovedCompliance() {
  redirect("/compliance");
}

import { LicensePanel } from "@/components/LicensePanel";

export const dynamic = "force-dynamic";

// The panel fetches its state from /api/admin/license on mount.
export default function LicensePage() {
  return <LicensePanel />;
}

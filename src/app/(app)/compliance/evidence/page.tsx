import { Evidence } from "@/components/compliance/Evidence";
import { evidencePageProps } from "../portal-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compliance · Evidence" };

// Compliance › Evidence (F2, 1.14.0): the stored snapshots with their
// hashes, Verify and the downloads, and the audit package. The section and
// compliance.export, else the shell's not-found page (portal-page.ts).

export default async function ComplianceEvidencePage() {
  const props = await evidencePageProps();
  return <Evidence {...props} />;
}

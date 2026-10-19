import { notFound } from "next/navigation";
import { userHolds } from "@/lib/access";
import { getAckSettings } from "@/lib/db";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { PolicySettingsPanel } from "@/components/PolicySettingsPanel";
import { ackPageContext } from "../data";

import type { Metadata } from "next";
import { cachedDocument } from "@/lib/page-data";
export const dynamic = "force-dynamic";

// The Settings tab of the Read confirmation pages (C2, 1.12.0): the
// per-policy settings, for those who may change how the policy asks. The
// header, the subtitle sentence and the Record · History · Settings row live
// in layout.tsx; the roster guard (ackPageContext) is the layout's, and this
// page adds the Settings tab's own: document.ack_require on the space, or
// compliance.program_manage, else the page does not exist for the caller
// (the sub-nav hides the tab on the same condition).

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await cachedDocument(Number(id)).catch(() => undefined);
  return {
    title: doc?.title ? `Read confirmation settings · ${doc.title}` : "Read confirmation settings",
  };
}

export default async function AckSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, doc } = await ackPageContext(Number(id));
  const [mayRequire, mayManage] = await Promise.all([
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
  ]);
  if (!mayRequire && !mayManage) notFound();

  const [settings, program] = await Promise.all([getAckSettings(doc.id), getComplianceSettings()]);
  if (!settings) notFound();

  return (
    <PolicySettingsPanel
      doc={{ id: doc.id, title: doc.title }}
      initial={{
        statement: settings.statement,
        statement_default: program.compliance_statement_default,
        signature: settings.signature,
      }}
    />
  );
}

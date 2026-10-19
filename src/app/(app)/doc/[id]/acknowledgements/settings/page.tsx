import { notFound } from "next/navigation";
import { userHolds, spaceScopeFor } from "@/lib/access";
import { getAckSettings, getAckRecert, getDocument, ackSummary } from "@/lib/db";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { PolicySettingsPanel } from "@/components/PolicySettingsPanel";
import { ackPageContext } from "../data";
import { listReplacementCandidates } from "./replacements";

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
//
// Three cards (wave 2 added the last two): Confirmation statement (C2),
// Re-confirmation (G1: the interval, the next date, the effective date) and
// Lifecycle (G3: the replacement, Retire policy, Un-retire). The page reads
// each card's values from the setter that owns them and hands the panel one
// `initial`; the panel's one Save row PATCHes /api/documents/[id]/ack-settings.

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
  const [mayRequire, mayManage, scope] = await Promise.all([
    userHolds(user, "document.ack_require", { spaceId: doc.space_id, legacyMin: "approver" }),
    userHolds(user, "compliance.program_manage", { legacyMin: "admin" }),
    spaceScopeFor(user),
  ]);
  if (!mayRequire && !mayManage) notFound();

  const [settings, recert, program, summary, replacements, replacement] = await Promise.all([
    getAckSettings(doc.id),
    getAckRecert(doc.id),
    getComplianceSettings(),
    // The standing for the Retire question ("42 of 50 people have confirmed
    // version 12") and the re-ask after an un-retire.
    ackSummary(doc.id),
    listReplacementCandidates(doc.id, scope),
    // The replacement's title for the chip; a document moved to the Trash
    // keeps the id (setSupersededBy's rule) and loses the title.
    doc.ack_superseded_by ? getDocument(doc.ack_superseded_by) : Promise.resolve(undefined),
  ]);
  if (!settings || !recert) notFound();

  return (
    <PolicySettingsPanel
      doc={{ id: doc.id, title: doc.title }}
      initial={{
        statement: settings.statement,
        statement_default: program.compliance_statement_default,
        signature: settings.signature,
        recert_months: recert.ack_recert_months,
        next_recert_at: recert.ack_next_recert_at,
        effective_at: recert.ack_effective_at,
        marker: recert.ack_revision_at,
        recert_default: program.ack_defaults.recert_months,
        superseded_by: doc.ack_superseded_by,
        superseded_by_title: replacement?.title ?? null,
        replacements: replacements.map((r) => ({ id: r.id, label: r.title, sublabel: `${r.space_icon} ${r.space_name}` })),
        required: doc.ack_required === 1,
        retired: doc.ack_retired_at
          ? { at: doc.ack_retired_at, by: doc.ack_retired_by_name, reason: doc.ack_retired_reason }
          : null,
        summary: { current: summary.current, eligible: summary.eligible, rev: summary.rev },
        viewerName: user.name || user.username,
      }}
    />
  );
}

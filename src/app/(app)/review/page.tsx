import { requirePermission } from "@/lib/auth";
import { spaceScopeFor } from "@/lib/access";
import { listChangeRequests, listSuggestions, getDocument, ackSummary } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { getComplianceSettings } from "@/lib/compliance-settings";
import { ReviewClient } from "@/components/ReviewClient";
import type { CrDetails } from "@/components/ReviewClient";
import { ClipboardCheck } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review queue" };

export default async function ReviewPage() {
  const user = await requirePermission("approver", "change_request.read");
  const scope = await spaceScopeFor(user);
  const [changeRequests, suggestions, ackOn] = await Promise.all([
    listChangeRequests("pending", scope),
    listSuggestions("open", scope),
    featureEnabled("policy_ack"),
  ]);

  // Per target document (several requests may name the same one): the live
  // text for the "Changes vs live" diff, and, when the document requires
  // read confirmation and the feature is licensed, the summary with the
  // confirmed text (A6): counts for the chip, the version people confirmed
  // and its text for the measurement. The list query stays narrow (the live
  // row is read FOR UPDATE inside the approval); this is the same batched
  // GET /api/documents/{id}/ack?baseline=1 read directly.
  const docIds = Array.from(new Set(changeRequests.map((cr) => cr.document_id)));
  const perDoc = new Map<number, CrDetails>();
  await Promise.all(
    docIds.map(async (docId) => {
      const live = await getDocument(docId);
      let ack: CrDetails["ack"] = null;
      if (live && ackOn && live.ack_required === 1) {
        const s = await ackSummary(docId, { baseline: true }).catch(() => null);
        if (s) {
          ack = {
            current: s.current,
            eligible: s.eligible,
            rev: s.baseline?.rev ?? s.rev,
            baseline: s.baseline ? { title: s.baseline.title, content: s.baseline.content } : null,
          };
        }
      }
      perDoc.set(docId, {
        live: live ? { title: live.title, content: live.content, status: live.status } : null,
        ack,
      });
    })
  );
  const details: Record<number, CrDetails> = {};
  for (const cr of changeRequests) {
    const d = perDoc.get(cr.document_id);
    if (d) details[cr.id] = d;
  }
  const keepReasonRequired = ackOn ? (await getComplianceSettings()).ack_defaults.keep_reason_required : true;

  return (
    <PageContainer>
      <PageHeader
        icon={<ClipboardCheck />}
        title="Review queue"
        subtitle="Approve or reject proposed changes, and triage suggestions from the team."
      />
      <ReviewClient
        changeRequests={changeRequests}
        suggestions={suggestions}
        details={details}
        keepReasonRequired={keepReasonRequired}
      />
    </PageContainer>
  );
}

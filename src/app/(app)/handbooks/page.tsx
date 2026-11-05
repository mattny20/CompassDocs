import { requireUser } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { canCreateHandbooks, listHandbooks } from "@/lib/handbooks";
import { PageContainer } from "@/components/PageWidth";
import { HandbookList } from "@/components/handbooks/HandbookList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Handbooks" };

// Handbooks (1.18.0): the handbooks this person can read and the drafts they
// can edit (lib/handbooks listHandbooks decides both), with New handbook for
// whoever may create one, workspace-wide or in a space they manage. The
// Confirmation column needs the Read confirmation licence.
export default async function HandbooksPage() {
  const user = await requireUser();
  const [rows, canCreate, policyAck] = await Promise.all([
    listHandbooks(user),
    canCreateHandbooks(user),
    featureEnabled("policy_ack"),
  ]);
  return (
    <PageContainer>
      <HandbookList rows={rows} canCreate={canCreate} showProgress={policyAck} />
    </PageContainer>
  );
}

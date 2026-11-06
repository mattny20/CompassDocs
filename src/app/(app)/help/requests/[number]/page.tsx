import { notFound } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { HelpGate } from "@/components/helpdesk/help/HelpGate";
import { RequestDetail } from "@/components/helpdesk/help/RequestDetail";
import { helpPageGuard } from "@/components/helpdesk/help/access";
import { requestClosedMessage } from "@/components/helpdesk/help/closed-notice";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ number: string }> };

export async function generateMetadata({ params }: Params) {
  const { number } = await params;
  return { title: `Request #${Number(number) || ""}`.trim() };
}

// One request (1.19.0): where it is, the conversation, the answers. The
// requester API answers only for the requester (and an approver deciding
// it), never with an internal note.
export default async function RequestPage({ params }: Params) {
  const [{ user, access }, { number }] = await Promise.all([helpPageGuard(), params]);
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) notFound();
  // An open request whose team is out of hours or on a holiday says so.
  const closed = access.licensed ? await requestClosedMessage(user, n) : null;
  return (
    <PageContainer>
      {access.licensed ? (
        <RequestDetail number={n} viewerId={user.id} closedNotice={closed} />
      ) : (
        <>
          <PageHeader icon={<LifeBuoy />} title={`Request #${n}`} />
          <HelpGate access={access}>{null}</HelpGate>
        </>
      )}
    </PageContainer>
  );
}

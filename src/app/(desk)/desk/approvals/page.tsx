// /desk/approvals: approvals the agent decides, and those their queues'
// requests are waiting on. The data loads from the approvals API.

import { DeskApprovals } from "@/components/helpdesk/desk/approvals/DeskApprovals";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

export default function DeskApprovalsPage() {
  return <DeskApprovals />;
}

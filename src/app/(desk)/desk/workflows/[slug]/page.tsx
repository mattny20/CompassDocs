// /desk/workflows/[slug]: the builder for one workflow (by its address
// name, or its id).

import { WorkflowBuilder } from "@/components/helpdesk/desk/workflows/WorkflowBuilder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workflow" };

export default async function WorkflowPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <WorkflowBuilder slug={decodeURIComponent(slug)} />;
}

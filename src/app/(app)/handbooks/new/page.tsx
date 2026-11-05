import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canCreateHandbooks, handbookOptions } from "@/lib/handbooks";
import { PageContainer } from "@/components/PageWidth";
import { HandbookEditor } from "@/components/handbooks/editor/HandbookEditor";

export const dynamic = "force-dynamic";
export const metadata = { title: "New handbook" };

// New handbook (1.18.0): the Details card alone (title, owner, introduction,
// audience, the confirmation switches); Create handbook opens the full
// editor, where the policies are added. Someone who may create no handbook
// at all gets the shell's not-found page, as the API would refuse them.
export default async function NewHandbookPage() {
  const user = await requireUser();
  if (!(await canCreateHandbooks(user))) notFound();
  const options = await handbookOptions(user);
  return (
    <PageContainer>
      <HandbookEditor initial={null} options={options} />
    </PageContainer>
  );
}

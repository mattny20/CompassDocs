import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManage, getHandbook, handbookOptions } from "@/lib/handbooks";
import type { SessionUser } from "@/lib/types";
import { PageContainer } from "@/components/PageWidth";
import { HandbookEditor } from "@/components/handbooks/editor/HandbookEditor";

export const dynamic = "force-dynamic";

// Edit a handbook (1.18.0, mock-ups 1-editor and 7-where-found). The guard is
// lib/handbooks canManage, the question every write route asks; anyone else
// gets the shell's not-found page, so a draft's existence is not revealed.
// The title and the body share one read per request.

const editable = cache(async (user: SessionUser, id: number) => {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  if (!(await canManage(user, id))) return undefined;
  return getHandbook(user, id, { forEdit: true });
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const h = await editable(user, Number(id));
  return { title: h ? `Edit · ${h.title}` : "Handbook" };
}

export default async function EditHandbookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const handbook = await editable(user, Number(id));
  if (!handbook) notFound();
  const options = await handbookOptions(user);
  return (
    <PageContainer>
      <HandbookEditor
        key={handbook.id}
        initial={handbook}
        options={options}
      />
    </PageContainer>
  );
}

import { notFound } from "next/navigation";
import { getDocument, listSpaces } from "@/lib/db";
import { DocEditor } from "@/components/DocEditor";

export const dynamic = "force-dynamic";

export default async function EditDocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDocument(Number(id));
  if (!doc) notFound();
  const spaces = listSpaces();

  return (
    <DocEditor
      mode="edit"
      spaces={spaces}
      initial={{
        id: doc.id,
        space_id: doc.space_id,
        title: doc.title,
        type: doc.type,
        status: doc.status,
        summary: doc.summary,
        tags: doc.tags,
        content: doc.content,
        author: doc.author,
      }}
    />
  );
}

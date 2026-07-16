import { notFound } from "next/navigation";
import { getDocument, listSpaces, getApprovalMode, listAllSpaceCategories } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { spaceScopeFor, scopeAllows, canEditSpace, editableScopeFor } from "@/lib/access";
import { roleAtLeast } from "@/lib/types";
import { DocEditor } from "@/components/DocEditor";

export const dynamic = "force-dynamic";

export default async function EditDocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole("editor");
  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) notFound();
  const scope = await spaceScopeFor(user);
  if (!scopeAllows(scope, doc.space_id)) notFound();
  if (!(await canEditSpace(user, doc.space_id))) notFound();
  // The move-to-space dropdown only offers spaces the user can author in.
  const spaces = await listSpaces(await editableScopeFor(user));
  const spaceIds = new Set(spaces.map((s) => s.id));
  const categories = (await listAllSpaceCategories()).filter(
    (c) => spaceIds.has(c.space_id) || c.space_id === doc.space_id
  );
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";

  return (
    <DocEditor
      mode="edit"
      canPublish={canPublish}
      spaces={spaces}
      categories={categories}
      initial={{
        id: doc.id,
        space_id: doc.space_id,
        category_id: doc.category_id,
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

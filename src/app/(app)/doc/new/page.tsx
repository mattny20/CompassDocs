import { listSpaces, getSpaceBySlug, getApprovalMode } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { spaceScopeFor } from "@/lib/access";
import { roleAtLeast } from "@/lib/types";
import { DocEditor } from "@/components/DocEditor";

export const dynamic = "force-dynamic";

export default async function NewDocPage({
  searchParams,
}: {
  searchParams: Promise<{ space?: string }>;
}) {
  const user = await requireRole("editor");
  const { space } = await searchParams;
  const spaces = await listSpaces(await spaceScopeFor(user));
  const preselected = space ? await getSpaceBySlug(space) : undefined;
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";

  return (
    <DocEditor
      mode="create"
      canPublish={canPublish}
      spaces={spaces}
      initial={{
        space_id: preselected?.id ?? spaces[0]?.id,
        title: "",
        type: "knowledge",
        status: "draft",
        summary: "",
        tags: [],
        content: "",
        author: "",
      }}
    />
  );
}

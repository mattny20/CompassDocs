import Link from "next/link";
import { listSpaces, getSpaceBySlug, getApprovalMode, listAllSpaceCategories } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { editableScopeFor } from "@/lib/access";
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
  // Only spaces the user can author in are offered (per-space edit rights).
  const spaces = await listSpaces(await editableScopeFor(user));
  if (spaces.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-8 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">No editable spaces</h1>
        <p className="mt-2 text-slate-500">
          You have the editor role, but no space currently grants you edit access. Ask an
          admin to add you (or one of your groups) to a space&apos;s editors.
        </p>
        <Link href="/" className="mt-4 inline-block font-medium text-compass-700 hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    );
  }
  const spaceIds = new Set(spaces.map((s) => s.id));
  const categories = (await listAllSpaceCategories()).filter((c) => spaceIds.has(c.space_id));
  const bySlug = space ? await getSpaceBySlug(space) : undefined;
  // Ignore a ?space= preselection the user can't author in.
  const preselected = bySlug && spaces.some((s) => s.id === bySlug.id) ? bySlug : undefined;
  const canPublish = roleAtLeast(user.role, "approver") || (await getApprovalMode()) === "open";

  return (
    <DocEditor
      mode="create"
      canPublish={canPublish}
      spaces={spaces}
      categories={categories}
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

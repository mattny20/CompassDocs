import { listSpaces, getSpaceBySlug } from "@/lib/db";
import { DocEditor } from "@/components/DocEditor";

export const dynamic = "force-dynamic";

export default async function NewDocPage({
  searchParams,
}: {
  searchParams: Promise<{ space?: string }>;
}) {
  const { space } = await searchParams;
  const spaces = listSpaces();
  const preselected = space ? getSpaceBySlug(space) : undefined;

  return (
    <DocEditor
      mode="create"
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

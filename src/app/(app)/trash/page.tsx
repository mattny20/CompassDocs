import { Trash2 } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { listTrashedDocuments, purgeExpiredTrash } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { TrashClient } from "@/components/TrashClient";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import type { DocStatus, DocType } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trash" };

const PAGE_SIZE = 50;

export default async function TrashPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  // Editors and up can see the Trash; permanent deletion is gated to admins
  // inside the client and the API.
  const user = await requirePermission("editor", "document.restore");
  const settings = await getAppSettings();
  const params = await searchParams;
  const q = (params.q ?? "").slice(0, 200);
  const page = Math.max(0, Number.parseInt(params.page ?? "0", 10) || 0);

  // Enforce the retention window whenever the Trash is opened.
  await purgeExpiredTrash(settings.trash_retention_days);

  const { rows, total } = await listTrashedDocuments({ q, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const retention = settings.trash_retention_days;

  return (
    <PageContainer>
      <PageHeader
        icon={<Trash2 />}
        title="Trash"
        subtitle={
          retention > 0 ? (
            <>
              Deleted documents are kept here and can be restored. They&rsquo;re
              permanently removed <strong>{retention}</strong> day{retention === 1 ? "" : "s"} after
              being trashed.
            </>
          ) : (
            <>Deleted documents are kept here until permanently removed. Auto-purge is off.</>
          )
        }
      />

      <TrashClient
        docs={rows.map((d) => ({
          id: d.id,
          title: d.title,
          type: d.type as DocType,
          status: d.status as DocStatus,
          space_name: d.space_name,
          space_icon: d.space_icon,
          deleted_at: d.deleted_at ?? null,
        }))}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        query={q}
        isAdmin={user.role === "admin"}
        settings={settings}
        retentionDays={retention}
      />
    </PageContainer>
  );
}

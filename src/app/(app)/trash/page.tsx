import { requireRole } from "@/lib/auth";
import { listTrashedDocuments, purgeExpiredTrash } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { TrashClient } from "@/components/TrashClient";

export const dynamic = "force-dynamic";

export default async function TrashPage() {
  // Editors and up can see the Trash; permanent deletion is gated to admins
  // inside the client and the API.
  const user = await requireRole("editor");
  const settings = await getAppSettings();

  // Enforce the retention window whenever the Trash is opened.
  await purgeExpiredTrash(settings.trash_retention_days);

  const docs = await listTrashedDocuments();
  const retention = settings.trash_retention_days;

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-2xl font-bold text-slate-900">Trash</h1>
      <p className="mb-6 mt-1 text-slate-500">
        {retention > 0 ? (
          <>
            Deleted documents are kept here and can be restored. They&rsquo;re
            permanently removed <strong>{retention}</strong> day{retention === 1 ? "" : "s"} after
            being trashed.
          </>
        ) : (
          <>Deleted documents are kept here until permanently removed. Auto-purge is off.</>
        )}
      </p>

      <TrashClient
        docs={docs.map((d) => ({
          id: d.id,
          title: d.title,
          type: d.type,
          status: d.status,
          space_name: d.space_name,
          space_icon: d.space_icon,
          deleted_at: d.deleted_at ?? null,
        }))}
        isAdmin={user.role === "admin"}
        settings={settings}
        retentionDays={retention}
      />
    </div>
  );
}

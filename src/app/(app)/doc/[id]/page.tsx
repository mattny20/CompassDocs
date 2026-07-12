import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocument, listVersions, listPendingForDocument } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getAppSettings } from "@/lib/settings-store";
import { formatDateTime } from "@/lib/format";
import { MarkdownView } from "@/components/MarkdownView";
import { TypeBadge, StatusBadge, Tag } from "@/components/Badges";
import { DocActions } from "@/components/DocActions";
import { SuggestBox } from "@/components/SuggestBox";
import { roleAtLeast } from "@/lib/types";
import { timeAgo } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = await getDocument(Number(id));
  if (!doc) notFound();

  const isStaff = roleAtLeast(user.role, "editor");
  // Viewers may not see drafts.
  if (doc.status === "draft" && !isStaff) notFound();

  const versionCount = (await listVersions(doc.id)).length;
  const pending = roleAtLeast(user.role, "approver") ? await listPendingForDocument(doc.id) : [];
  const settings = await getAppSettings();

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-slate-400">
        <Link href="/" className="hover:text-slate-600">
          Home
        </Link>
        <span>/</span>
        <Link href={`/spaces/${doc.space_slug}`} className="hover:text-slate-600">
          {doc.space_icon} {doc.space_name}
        </Link>
      </nav>

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <TypeBadge type={doc.type} />
            <StatusBadge status={doc.status} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">{doc.title}</h1>
        </div>
        <DocActions
          id={doc.id}
          spaceSlug={doc.space_slug}
          role={user.role}
          isPublished={doc.status === "published"}
        />
      </div>

      {doc.status === "draft" && isStaff && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
          📝 This is a <strong>draft</strong> — it isn&apos;t visible to viewers yet.
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          ⏳ {pending.length} pending change{pending.length === 1 ? "" : "s"} awaiting review.{" "}
          <Link href="/review" className="font-medium underline">
            Open review queue →
          </Link>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 pb-4 text-sm text-slate-500">
        <span>
          By <span className="font-medium text-slate-700">{doc.author}</span>
        </span>
        <span>·</span>
        <span title={formatDateTime(doc.updated_at, settings)}>Updated {timeAgo(doc.updated_at)}</span>
        <span>·</span>
        <Link href={`/doc/${doc.id}/history`} className="hover:text-compass-600">
          {versionCount} version{versionCount === 1 ? "" : "s"}
        </Link>
        {doc.tags.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>·</span>
            {doc.tags.map((t) => (
              <Tag key={t} label={t} />
            ))}
          </span>
        )}
      </div>

      {doc.summary && (
        <p className="mb-6 rounded-lg border-l-4 border-compass-300 bg-compass-50/50 px-4 py-3 text-slate-600">
          {doc.summary}
        </p>
      )}

      <article>
        <MarkdownView content={doc.content} />
      </article>

      <SuggestBox documentId={doc.id} />
    </div>
  );
}

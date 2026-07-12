import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocument, listVersions } from "@/lib/db";
import { MarkdownView } from "@/components/MarkdownView";
import { TypeBadge, StatusBadge, Tag } from "@/components/Badges";
import { DocActions } from "@/components/DocActions";
import { timeAgo } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function DocPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDocument(Number(id));
  if (!doc) notFound();

  const versionCount = listVersions(doc.id).length;

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      {/* Breadcrumb */}
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
        <DocActions id={doc.id} spaceSlug={doc.space_slug} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 pb-4 text-sm text-slate-500">
        <span>
          By <span className="font-medium text-slate-700">{doc.author}</span>
        </span>
        <span>·</span>
        <span>Updated {timeAgo(doc.updated_at)}</span>
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
    </div>
  );
}

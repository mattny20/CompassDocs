import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSpaceBySlug, getDocumentBySpaceAndSlug, listAttachments } from "@/lib/db";
import { DOC_TYPE_LABEL } from "@/lib/types";
import { MarkdownView } from "@/components/MarkdownView";
import { Paperclip } from "lucide-react";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

async function publicDoc(spaceSlug: string, docSlug: string) {
  const space = await getSpaceBySlug(spaceSlug);
  if (!space || space.visibility !== "public") notFound();
  const doc = await getDocumentBySpaceAndSlug(space.id, docSlug);
  // Drafts are never public, and a wrong slug 404s indistinguishably.
  if (!doc || doc.status !== "published") notFound();
  return { space, doc };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ space: string; doc: string }>;
}): Promise<Metadata> {
  const p = await params;
  const { doc } = await publicDoc(p.space, p.doc);
  return { title: doc.title, description: doc.summary || undefined };
}

export default async function PublicDocPage({
  params,
}: {
  params: Promise<{ space: string; doc: string }>;
}) {
  const p = await params;
  const { space, doc } = await publicDoc(p.space, p.doc);
  const attachments = await listAttachments(doc.id);

  return (
    <article>
      <nav className="mb-4 flex items-center text-sm text-slate-400 print:hidden">
        <span>
          <Link href="/public" className="hover:text-compass-700">
            Home
          </Link>
          {" / "}
          <Link href={`/public/${space.slug}`} className="hover:text-compass-700">
            {space.name}
          </Link>
        </span>
        <span className="ml-auto">
          <PrintButton compact />
        </span>
      </nav>

      <h1 className="text-3xl font-bold text-slate-900">{doc.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
          {DOC_TYPE_LABEL[doc.type]}
        </span>
        <span>
          Updated{" "}
          {new Date(doc.updated_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </span>
        {doc.tags.length > 0 && <span>· {doc.tags.join(", ")}</span>}
      </div>

      <div className="prose prose-slate mt-8 max-w-none rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <MarkdownView content={doc.content} docKey={`pub-${doc.id}`} />
      </div>

      {attachments.length > 0 && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm print:hidden">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Attachments</h2>
          <ul className="space-y-1">
            {attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={`/api/attachments/${a.id}`}
                  className="inline-flex items-center gap-1.5 text-sm text-compass-700 hover:underline"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {a.filename}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { getDocument, listVersions } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { roleAtLeast } from "@/lib/types";
import { timeAgo } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = getDocument(Number(id));
  if (!doc) notFound();
  if (doc.status === "draft" && !roleAtLeast(user.role, "editor")) notFound();
  const versions = listVersions(doc.id);

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-slate-400">
        <Link href={`/doc/${doc.id}`} className="hover:text-slate-600">
          ← Back to document
        </Link>
      </nav>
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Version history</h1>
      <p className="mb-6 text-slate-500">{doc.title}</p>

      <ol className="relative border-l border-slate-200 pl-6">
        {versions.map((v, i) => (
          <li key={v.id} className="mb-6 last:mb-0">
            <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-compass-500" />
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-800">
                  {i === 0 ? "Current" : `Revision ${versions.length - i}`}
                  <span className="ml-2 text-sm font-normal text-slate-400">{v.note}</span>
                </span>
                <span className="text-xs text-slate-400">{timeAgo(v.created_at)}</span>
              </div>
              <div className="mt-1 text-sm text-slate-500">
                {v.title} · edited by {v.author}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-compass-600">
                  Preview content
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-600">
                  {v.content}
                </pre>
              </details>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

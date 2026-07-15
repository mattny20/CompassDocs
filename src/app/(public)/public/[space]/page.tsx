import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSpaceBySlug, listDocumentsBySpace } from "@/lib/db";
import { DOC_TYPE_LABEL } from "@/lib/types";

export const dynamic = "force-dynamic";

async function publicSpace(slug: string) {
  const space = await getSpaceBySlug(slug);
  // Non-public spaces 404 identically to nonexistent ones — no name leaks.
  if (!space || space.visibility !== "public") notFound();
  return space;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ space: string }>;
}): Promise<Metadata> {
  const space = await publicSpace((await params).space);
  return { title: space.name, description: space.description || undefined };
}

export default async function PublicSpacePage({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const space = await publicSpace((await params).space);
  const docs = await listDocumentsBySpace(space.id, false); // published only

  return (
    <div>
      <div className="flex items-center gap-4">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-xl text-2xl"
          style={{ backgroundColor: `${space.color}1a` }}
        >
          {space.icon}
        </span>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{space.name}</h1>
          {space.description && <p className="text-slate-500">{space.description}</p>}
        </div>
      </div>

      {docs.length === 0 ? (
        <p className="mt-10 rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400">
          Nothing published here yet.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
          {docs.map((d) => (
            <li key={d.id}>
              <Link
                href={`/public/${space.slug}/${d.slug}`}
                className="flex items-baseline gap-3 px-5 py-4 transition hover:bg-slate-50"
              >
                <span className="font-medium text-compass-700">{d.title}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                  {DOC_TYPE_LABEL[d.type]}
                </span>
                {d.summary && (
                  <span className="hidden truncate text-sm text-slate-400 sm:inline">
                    {d.summary}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

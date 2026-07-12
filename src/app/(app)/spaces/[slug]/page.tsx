import Link from "next/link";
import { notFound } from "next/navigation";
import { getSpaceBySlug, listDocumentsBySpace } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { roleAtLeast } from "@/lib/types";
import { DocCard } from "@/components/DocCard";

export const dynamic = "force-dynamic";

export default async function SpacePage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const space = await getSpaceBySlug(slug);
  if (!space) notFound();

  const isEditor = roleAtLeast(user.role, "editor");
  const docs = await listDocumentsBySpace(space.id, isEditor);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div
            className="grid h-12 w-12 place-items-center rounded-xl text-2xl"
            style={{ backgroundColor: `${space.color}1a` }}
          >
            {space.icon}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{space.name}</h1>
            <p className="text-slate-500">{space.description}</p>
          </div>
        </div>
        {isEditor && (
          <Link
            href={`/doc/new?space=${space.slug}`}
            className="whitespace-nowrap rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
          >
            ＋ New in {space.name}
          </Link>
        )}
      </div>

      {docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          No documents in this space yet.
          {isEditor && (
            <>
              {" "}
              <Link href={`/doc/new?space=${space.slug}`} className="font-medium text-compass-600">
                Create the first one →
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {docs.map((d) => (
            <DocCard key={d.id} doc={d} />
          ))}
        </div>
      )}
    </div>
  );
}

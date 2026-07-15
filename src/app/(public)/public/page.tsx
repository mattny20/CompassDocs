import Link from "next/link";
import { listPublicSpaces } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function PublicHome() {
  const spaces = await listPublicSpaces();

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Knowledge base</h1>
      <p className="mt-1 text-slate-500">Browse the published documentation.</p>

      {spaces.length === 0 ? (
        <p className="mt-10 rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-400">
          Nothing published here yet.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {spaces.map((s) => (
            <Link
              key={s.id}
              href={`/public/${s.slug}`}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-compass-300 hover:shadow"
            >
              <div className="flex items-center gap-3">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-xl"
                  style={{ backgroundColor: `${s.color}1a` }}
                >
                  {s.icon}
                </span>
                <div>
                  <div className="font-semibold text-slate-900">{s.name}</div>
                  <div className="text-xs text-slate-400">
                    {s.doc_count} article{s.doc_count === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              {s.description && <p className="mt-3 text-sm text-slate-500">{s.description}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { getAppSettings } from "@/lib/settings-store";
import { listSpaces, listRecentDocuments, countDocuments, allTags } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor } from "@/lib/access";
import { roleAtLeast } from "@/lib/types";
import { DocCard } from "@/components/DocCard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const includeDrafts = roleAtLeast(user.role, "editor");
  const scope = await spaceScopeFor(user);
  const settingsName = (await getAppSettings()).company_name;
  const [spaces, recent, totalDocs, allTagList] = await Promise.all([
    listSpaces(scope),
    listRecentDocuments(6, includeDrafts, scope),
    countDocuments(includeDrafts, scope),
    allTags(),
  ]);
  const tags = allTagList.slice(0, 12);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Welcome to CompassDocs</h1>
        <p className="mt-1 text-slate-500">
          Your team&apos;s knowledge base — SOPs, technical docs, policies, and how-tos, all
          searchable in one place.
        </p>
      </header>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Documents" value={totalDocs} />
        <Stat label="Spaces" value={spaces.length} />
        <Stat label="Tags" value={allTagList.length} />
        <Link
          href="/search"
          className="flex flex-col justify-center rounded-xl border border-compass-200 bg-compass-50 p-4 transition hover:border-compass-300"
        >
          <span className="text-sm font-semibold text-compass-700">✨ Ask {settingsName}</span>
          <span className="mt-0.5 text-xs text-compass-600/80">AI-powered answers</span>
        </Link>
      </div>

      {/* Spaces */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Spaces</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {spaces.map((s) => (
            <Link
              key={s.id}
              href={`/spaces/${s.slug}`}
              className="group rounded-xl border border-slate-200 bg-surface p-4 shadow-sm transition hover:border-compass-300 hover:shadow-md"
            >
              <div
                className="mb-3 grid h-10 w-10 place-items-center rounded-lg text-xl"
                style={{ backgroundColor: `${s.color}1a` }}
              >
                {s.icon}
              </div>
              <h3 className="font-semibold text-slate-900 group-hover:text-compass-700">
                {s.name}
              </h3>
              <p className="mt-1 line-clamp-2 text-sm text-slate-500">{s.description}</p>
              <p className="mt-3 text-xs text-slate-400">{s.doc_count} documents</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Recent */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Recently updated</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recent.map((d) => (
            <DocCard key={d.id} doc={d} />
          ))}
        </div>
      </section>

      {/* Tags */}
      {tags.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Popular tags</h2>
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <Link
                key={t.tag}
                href={`/search?q=${encodeURIComponent(t.tag)}`}
                className="rounded-full border border-slate-200 bg-surface px-3 py-1 text-sm text-slate-600 transition hover:border-compass-300 hover:text-compass-700"
              >
                #{t.tag} <span className="text-slate-400">{t.count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="text-2xl font-bold text-slate-900">{value}</div>
      <div className="text-sm text-slate-500">{label}</div>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getSpaceBySlug,
  listDocumentsBySpace,
  listSpaceCategories,
  getSubscriptionState,
} from "@/lib/db";
import { SubscribeButton } from "@/components/SubscribeButton";
import { SpaceSearch } from "@/components/SpaceSearch";
import { PageContainer } from "@/components/PageWidth";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { roleAtLeast } from "@/lib/types";
import type { DocumentWithSpace } from "@/lib/types";
import { DocCard } from "@/components/DocCard";
import { CornerDownRight } from "lucide-react";

/** Compact nested list of a doc's sub-pages (and theirs), under its card. */
function ChildList({
  parentId,
  byParent,
  depth,
}: {
  parentId: number;
  byParent: Map<number, DocumentWithSpace[]>;
  depth: number;
}) {
  const kids = byParent.get(parentId);
  if (!kids?.length || depth > 3) return null;
  return (
    <ul className={`mt-1.5 space-y-0.5 border-l-2 border-slate-100 pl-3 ${depth > 1 ? "ml-1" : "ml-2"}`}>
      {kids.map((k) => (
        <li key={k.id}>
          <Link
            href={`/doc/${k.id}`}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-compass-700"
          >
            <CornerDownRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />
            <span className="min-w-0 truncate" title={k.title}>
              {k.title}
            </span>
            {k.status === "draft" && (
              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-medium uppercase text-slate-500">
                Draft
              </span>
            )}
          </Link>
          <div className="pl-4">
            <ChildList parentId={k.id} byParent={byParent} depth={depth + 1} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export const dynamic = "force-dynamic";

export default async function SpacePage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const space = await getSpaceBySlug(slug);
  if (!space) notFound();
  if (!scopeAllows(await spaceScopeFor(user), space.id)) notFound();

  const isEditor = roleAtLeast(user.role, "editor");
  const [docs, categories, sub, canAuthor] = await Promise.all([
    listDocumentsBySpace(space.id, isEditor),
    listSpaceCategories(space.id),
    getSubscriptionState(space.id, user.id),
    canEditSpace(user, space.id),
  ]);

  // Nested pages (admin-gated): sub-pages render under their parent's card
  // rather than as their own cards. A child whose parent isn't visible here
  // (trashed, or a draft hidden from viewers) surfaces at the top level.
  const nestedOn = (await getAppSettings()).nested_pages_enabled;
  const visibleIds = new Set(docs.map((d) => d.id));
  const byParent = new Map<number, DocumentWithSpace[]>();
  let topLevel = docs;
  if (nestedOn) {
    topLevel = [];
    for (const d of docs) {
      if (d.parent_id !== null && visibleIds.has(d.parent_id)) {
        (byParent.get(d.parent_id) ?? byParent.set(d.parent_id, []).get(d.parent_id)!).push(d);
      } else {
        topLevel.push(d);
      }
    }
    for (const kids of byParent.values()) {
      kids.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    }
  }

  // Group documents by category (categories in admin order, General last).
  const byCategory = new Map<number | null, DocumentWithSpace[]>();
  for (const d of topLevel) {
    const key = d.category_id ?? null;
    (byCategory.get(key) ?? byCategory.set(key, []).get(key)!).push(d);
  }
  const sections: { name: string | null; docs: DocumentWithSpace[] }[] = [];
  for (const c of categories) {
    const rows = byCategory.get(c.id);
    if (rows?.length) sections.push({ name: c.name, docs: rows });
  }
  const general = byCategory.get(null);
  if (general?.length) {
    // Only label the leftovers when there are named sections above them.
    sections.push({ name: sections.length > 0 ? "General" : null, docs: general });
  }

  return (
    <PageContainer>
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
        <div className="flex shrink-0 items-center gap-2">
          <SubscribeButton
            spaceId={space.id}
            initialState={sub.state}
            initialViaGroup={sub.viaGroup}
          />
          {isEditor && canAuthor && (
            <Link
              href={`/doc/new?space=${space.slug}`}
              className="whitespace-nowrap rounded-lg bg-compass-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700"
            >
              ＋ New in {space.name}
            </Link>
          )}
        </div>
      </div>

      <SpaceSearch spaceId={space.id} spaceName={space.name}>
        {docs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-surface p-10 text-center text-slate-500">
            No documents in this space yet.
            {isEditor && canAuthor && (
              <>
                {" "}
                <Link href={`/doc/new?space=${space.slug}`} className="font-medium text-compass-600">
                  Create the first one →
                </Link>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {sections.map((s, i) => (
              <section key={s.name ?? `general-${i}`}>
                {s.name && (
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {s.name}
                  </h2>
                )}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {s.docs.map((d) => (
                    <div key={d.id}>
                      <DocCard doc={d} />
                      {nestedOn && <ChildList parentId={d.id} byParent={byParent} depth={1} />}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </SpaceSearch>
    </PageContainer>
  );
}

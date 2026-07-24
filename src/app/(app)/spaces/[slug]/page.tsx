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
import { SpaceViews } from "@/components/SpaceViews";
import { PageContainer } from "@/components/PageWidth";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor, scopeAllows, canEditSpace } from "@/lib/access";
import { getAppSettings } from "@/lib/settings-store";
import { roleAtLeast } from "@/lib/types";
import type { DocumentWithSpace } from "@/lib/types";

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

  const nestedOn = (await getAppSettings()).nested_pages_enabled;

  // Ship the metadata each view needs, but never the full markdown bodies —
  // they'd bloat the page payload for no reason.
  const lite = docs.map(({ content, ...rest }) => rest) as DocumentWithSpace[];

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
          <SpaceViews
            docs={lite}
            categories={categories.map((c) => ({ id: c.id, name: c.name }))}
            spaceId={space.id}
            defaultView={space.default_view ?? "cards"}
            nestedPages={nestedOn}
          />
        )}
      </SpaceSearch>
    </PageContainer>
  );
}

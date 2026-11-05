// Latest in your spaces (1.17.0): the recently updated documents as a compact
// table (Document | Space | Updated by | when) with a Following | Everything
// switch. Following is the spaces the person follows (their own
// subscriptions plus the admin-assigned group ones they have not muted) and
// is the default whenever they follow any; Everything is every space they can
// read. Below a ~40rem tile the Space and Updated-by columns fold under the
// title. Never repeats what the pick-up cards above show (1.9.3). Server
// component; fetches its own data.

import Link from "next/link";
import { DashboardTile } from "./DashboardTile";
import { LatestViewSwitch, type LatestView } from "./LatestViewSwitch";
import { listFollowedSpaceIds, listLatestDocuments } from "@/lib/dashboard-data";
import type { SpaceScope } from "@/lib/space-scope";
import type { SessionUser } from "@/lib/types";
import { TypeBadge } from "@/components/Badges";
import { Chip } from "@/components/Chip";
import { RelativeTime } from "@/components/RelativeTime";
import { SectionEmpty } from "@/components/form";
import { initialsOf } from "@/components/UserAvatar";
import { EYEBROW_TEXT } from "@/components/Heading";

const TH = `px-4 py-2 font-semibold ${EYEBROW_TEXT}`;

export async function LatestTile({
  user,
  scope,
  includeDrafts,
  view: asked,
  excludeIds,
}: {
  user: SessionUser;
  scope: SpaceScope;
  includeDrafts: boolean;
  /** From ?latest=; anything else falls back to the default. */
  view?: string;
  /** Documents already on the page (the pick-up cards); may still be loading. */
  excludeIds: number[] | Promise<number[]>;
}) {
  const [followed, exclude] = await Promise.all([listFollowedSpaceIds(user.id, scope), excludeIds]);
  const view: LatestView =
    asked === "following" || asked === "everything" ? asked : followed.length > 0 ? "following" : "everything";
  const docs = await listLatestDocuments({
    scope,
    includeDrafts,
    spaceIds: view === "following" ? followed : undefined,
    excludeIds: exclude,
    limit: 8,
  });

  return (
    <DashboardTile
      id="latest"
      title="Latest in your spaces"
      actions={<LatestViewSwitch value={view} />}
      flush
      footer={
        <span className="text-slate-500">
          {view === "following" ? "Updated in the spaces you follow" : "Updated across your spaces"}
        </span>
      }
    >
      {docs.length === 0 ? (
        <SectionEmpty
          className="border-t border-slate-100 px-4 py-6"
          action={view === "following" ? { href: "/?latest=everything", label: "Show everything" } : undefined}
        >
          {view === "everything"
            ? "Nothing here yet — publish a first document to get the ball rolling."
            : followed.length === 0
              ? "You don't follow any spaces yet. Follow one from its page to see its updates here."
              : "Nothing new in the spaces you follow."}
        </SectionEmpty>
      ) : (
        // A container, so the columns fold on the tile's width rather than
        // the screen's (the tile is narrower than the page at Normal width).
        <div className="@container">
          <table className="w-full table-fixed text-sm">
            <thead className="border-y border-slate-100 bg-slate-50 text-left">
              <tr>
                <th scope="col" className={TH}>
                  Document
                </th>
                <th scope="col" className={`hidden w-[12.5rem] @min-[40rem]:table-cell ${TH}`}>
                  Space
                </th>
                <th scope="col" className={`hidden w-[10rem] @min-[40rem]:table-cell ${TH}`}>
                  Updated by
                </th>
                <th scope="col" className={`w-[5.5rem] text-right ${TH}`}>
                  <span className="sr-only">Updated</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 transition-colors last:border-b-0 hover:bg-slate-50/70">
                  <td className="px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={`/doc/${d.id}`}
                        className="truncate font-semibold text-slate-900 hover:text-compass-700"
                      >
                        {d.title}
                      </Link>
                      {d.status === "draft" && (
                        <Chip tone="neutral" size="sm">
                          Draft
                        </Chip>
                      )}
                      <span className="ml-auto shrink-0">
                        <TypeBadge type={d.type} />
                      </span>
                    </div>
                    {/* Folded: where and who under the title. */}
                    <p className="mt-0.5 truncate text-xs text-slate-500 @min-[40rem]:hidden">
                      <span aria-hidden>{d.space_icon}</span> {d.space_name} · {d.author}
                    </p>
                  </td>
                  <td className="hidden truncate px-4 py-2.5 text-slate-600 @min-[40rem]:table-cell">
                    <Link href={`/spaces/${d.space_slug}`} className="hover:text-compass-700">
                      <span className="mr-1.5" aria-hidden>
                        {d.space_icon}
                      </span>
                      {d.space_name}
                    </Link>
                  </td>
                  <td className="hidden truncate px-4 py-2.5 text-slate-600 @min-[40rem]:table-cell">
                    <span
                      aria-hidden
                      className="mr-2 inline-grid h-5.5 w-5.5 place-items-center rounded-full bg-compass-100 align-middle text-3xs font-bold text-compass-700"
                    >
                      {initialsOf(d.author)}
                    </span>
                    {d.author}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-slate-500">
                    <RelativeTime value={d.updated_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardTile>
  );
}

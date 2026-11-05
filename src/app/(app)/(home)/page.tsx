import Link from "next/link";
import { getAppSettings } from "@/lib/settings-store";
import { PageContainer } from "@/components/PageWidth";
import { askLabel } from "@/lib/nav-items";
import {
  listRecentlyViewedBy,
  listDraftsByAuthor,
  listPendingAcksFor,
  countOverdueAcksFor,
  listActiveAnnouncementsFor,
  listDashboardNewslettersFor,
  listChangeRequests,
  listSuggestions,
} from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor, userHolds, type SpaceScope } from "@/lib/access";
import { findScopeFor, type FindScope } from "@/lib/handbook-visibility";
import { navCapabilities, type NavCapabilities } from "@/lib/nav-capabilities";
import { featureEnabled } from "@/lib/ee";
import { timeAgo } from "@/lib/ui";
import { DASHBOARD_SECTIONS, getHiddenDashboardSections } from "@/lib/dashboard-sections";
import type { SessionUser } from "@/lib/types";
import { AnnouncementBoard } from "@/components/AnnouncementBoard";
import { NewsletterBoard } from "@/components/NewsletterBoard";
import { DashboardGreeting } from "@/components/DashboardGreeting";
import { StatusBadge } from "@/components/Badges";
import { listReviewsDue } from "@/lib/reviews";
import { formatDate, settingsForUser } from "@/lib/format";
import { EditDashboardButton } from "@/components/dashboard/EditDashboardButton";
import { StatusStrip } from "@/components/dashboard/StatusStrip";
import { LatestTile } from "@/components/dashboard/LatestTile";
import { PopularTile } from "@/components/dashboard/PopularTile";
import { SpacesTile } from "@/components/dashboard/SpacesTile";
import { QuickLinksTile } from "@/components/dashboard/QuickLinksTile";
import { MyTeamTile } from "@/components/dashboard/MyTeamTile";
import { PeopleThisWeekTile } from "@/components/dashboard/PeopleThisWeekTile";
import { MyTrainingTile } from "@/components/dashboard/MyTrainingTile";
import { TeamComplianceTile } from "@/components/dashboard/TeamComplianceTile";
import {
  Sparkles,
  CalendarClock,
  ClipboardCheck,
  GitPullRequest,
  MessageSquareText,
  PenLine,
  ChevronRight,
} from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

type AppSettings = Awaited<ReturnType<typeof getAppSettings>>;
type Doc = Awaited<ReturnType<typeof listRecentlyViewedBy>>[number];

/**
 * The pick-up cards' documents, started once and awaited twice: the cards
 * render them, and Latest leaves them out (1.9.3) without a second query.
 */
async function loadPickUp(user: SessionUser, scope: SpaceScope, isEditor: boolean, find: Promise<FindScope>) {
  const [recentlyViewed, myDrafts] = await Promise.all([
    find.then((f) => listRecentlyViewedBy(user.id, scope, isEditor, 5, f)), // Handbooks 1.18.0 (H6)
    isEditor ? listDraftsByAuthor(user.name, scope, 3) : Promise.resolve([] as Doc[]),
  ]);
  // Drafts also appear in "recently viewed" — don't show them twice.
  const draftIds = new Set(myDrafts.map((d) => d.id));
  const continueDocs = recentlyViewed.filter((d) => !draftIds.has(d.id)).slice(0, 4);
  return { myDrafts, continueDocs };
}

type PickUp = Awaited<ReturnType<typeof loadPickUp>>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ latest?: string }>;
}) {
  const user = await requireUser();
  const [{ latest: latestView }, caps, scope, appSettings, hidden, canCreateSpace, ackOn] = await Promise.all([
    searchParams,
    // Same resolution the sidebar and palette use, so the dashboard cannot
    // show a review queue the nav says you have no access to.
    navCapabilities(user),
    spaceScopeFor(user),
    getAppSettings(),
    getHiddenDashboardSections(user.id),
    // "New space" on the Spaces tile: the create permission and the page
    // that holds the form (Settings → Spaces).
    Promise.all([
      userHolds(user, "space.create", { legacyMin: "admin" }),
      userHolds(user, "space.manage_members", { legacyMin: "admin" }),
    ]).then(([create, page]) => create && page),
    featureEnabled("policy_ack"),
  ]);
  const show = (key: string) => !hidden.has(key);
  // Handbooks 1.18.0 (H6): Continue, Latest, Popular and the Spaces tile leave
  // handbook-only documents out for readers (policies to confirm, training
  // and team compliance stay: they are a task, not a find). Started here,
  // awaited by each tile; findScopeFor is cached per request.
  const find = findScopeFor(user);
  // Started here, awaited by the pinned blocks and by Latest.
  const pickUp = loadPickUp(user, scope, caps.isEditor, find);

  // Edit dashboard offers what this workspace has: no Training switch
  // without the training feature, no Team compliance without read
  // confirmations.
  const editable = DASHBOARD_SECTIONS.filter(
    (s) => (s.key !== "training" || caps.showTraining) && (s.key !== "compliance" || ackOn)
  ).map(({ key, label, help }) => ({ key, label, help }));

  return (
    <PageContainer>
      {/* Greeting + hero search */}
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {/* Edit dashboard sits on the date's line: the greeting's own box
            dissolves into this row (its h1 takes a line of its own), so the
            link follows the date however long the weekday is, and wraps
            under it on a phone. */}
        <div className="flex flex-wrap items-baseline gap-x-3 [&>div]:contents [&_h1]:basis-full">
          <DashboardGreeting name={user.name || user.username} />
          <EditDashboardButton sections={editable} hidden={[...hidden]} />
        </div>
        {/* The Ask entry — not a second search box. Ctrl K is the palette
            (sidebar trigger), so no keycap here; the width follows the page
            instead of a fixed 24rem that truncated the copy at 1920+. */}
        <Link
          href="/search"
          className="group flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-surface px-4 py-3 text-slate-500 shadow-xs transition hover:border-compass-300 hover:shadow-md sm:w-auto sm:min-w-80 sm:max-w-2xl sm:flex-1"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-compass-500" aria-hidden />
          <span className="flex-1 truncate text-sm">
            {askLabel(appSettings.company_name)} anything — or search by keyword…
          </span>
        </Link>
      </header>

      {/* The status strip replaces the old problems banner (1.17.0). */}
      {show("status") && <StatusStrip />}

      <PinnedBlocks user={user} caps={caps} scope={scope} appSettings={appSettings} ackOn={ackOn} pickUp={pickUp} />

      {/* The tiles (STYLEGUIDE §Dashboard tiles): two columns once the
          content column is at least 56rem (a container query, not a
          viewport breakpoint, so Normal stacks and Wide/Full split whatever
          the monitor), the right one 19rem; one column below, the right
          column's tiles after the left's. Every tile fetches its own data,
          so the sections render in parallel, and a tile that does not apply
          returns nothing; a column left empty disappears with its gap.
          Overlays inside are portalled Modals: a container is a containing
          block for fixed descendants (STYLEGUIDE §Overlays). */}
      <div className="@container">
        <div className="flex flex-col gap-6 @4xl:flex-row @4xl:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-6 [&:not(:has(section))]:hidden">
            {show("latest") && (
              <LatestTile
                user={user}
                scope={scope}
                includeDrafts={caps.isEditor}
                view={latestView}
                find={find}
                excludeIds={pickUp.then((p) => [...p.myDrafts, ...p.continueDocs].map((d) => d.id))}
              />
            )}
            {show("popular") && <PopularTile scope={scope} includeDrafts={caps.isEditor} find={find} />}
            {show("spaces") && <SpacesTile scope={scope} canCreate={canCreateSpace} find={find} />}
            {/* Side by side when both apply and fit; one alone takes the row. */}
            <div className="grid gap-6 empty:hidden [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
              {show("training") && caps.showTraining && <MyTrainingTile user={user} />}
              {show("compliance") && ackOn && <TeamComplianceTile user={user} />}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-6 empty:hidden @4xl:w-[19rem] @4xl:shrink-0">
            {show("quick_links") && <QuickLinksTile user={user} />}
            {show("my_team") && <MyTeamTile user={user} />}
            {show("people") && <PeopleThisWeekTile user={user} />}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

/**
 * Everything above the tiles that is waiting on this person: announcements,
 * newsletters, Needs your attention and Pick up where you left off. These
 * are not sections and cannot be hidden.
 */
async function PinnedBlocks({
  user,
  caps,
  scope,
  appSettings,
  ackOn,
  pickUp,
}: {
  user: SessionUser;
  caps: NavCapabilities;
  scope: SpaceScope;
  appSettings: AppSettings;
  /** The read-confirmation feature (policy_ack) is on. */
  ackOn: boolean;
  pickUp: Promise<PickUp>;
}) {
  const { isEditor, isApprover } = caps;
  const [
    { myDrafts, continueDocs },
    pendingAcks,
    overdueAcks,
    announcements,
    newsletters,
    reviewsDue,
    pendingCrs,
    openSuggestions,
  ] = await Promise.all([
    pickUp,
    // The policies to confirm, in the person's priority (overdue first, then
    // the soonest deadline), and how many are overdue (E1, 1.13.0).
    ackOn ? listPendingAcksFor(user.id, scope) : Promise.resolve([]),
    ackOn ? countOverdueAcksFor(user.id, scope) : Promise.resolve(0),
    listActiveAnnouncementsFor(user.id),
    listDashboardNewslettersFor(user.id),
    isEditor ? listReviewsDue(scope, 12) : Promise.resolve([]),
    isApprover ? listChangeRequests("pending", scope) : Promise.resolve([]),
    isEditor ? listSuggestions("open", scope) : Promise.resolve([]),
  ]);

  const attentionCount =
    pendingAcks.length + reviewsDue.length + pendingCrs.length + openSuggestions.length;

  return (
    <>
      <AnnouncementBoard
        initial={announcements.map((a) => ({
          id: a.id,
          title: a.title,
          body: a.body,
          level: a.level,
          author_name: a.author_name,
          created_at: a.created_at,
          link: a.link,
        }))}
      />

      <NewsletterBoard
        initial={newsletters.map((n) => ({
          id: n.id,
          subject: n.subject,
          author_name: n.author_name,
          sent_at: String(n.sent_at),
        }))}
      />

      {/* Needs your attention — one card for everything waiting on YOU */}
      {attentionCount > 0 && (
        <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/40">
          <h2 className="border-b border-amber-200/70 px-4 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-800/50 dark:text-amber-200">
            Needs your attention ({attentionCount})
          </h2>
          <div className="divide-y divide-amber-200/60 dark:divide-amber-800/40">
            {pendingCrs.length > 0 && (
              <AttentionRow
                href="/review"
                icon={<GitPullRequest className="h-4 w-4" aria-hidden />}
                label={`${pendingCrs.length} change request${pendingCrs.length === 1 ? "" : "s"} waiting for your review`}
                detail={pendingCrs
                  .map((cr) => cr.document_title || cr.title)
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(" · ")}
              />
            )}
            {pendingAcks.length > 0 && (
              // One policy: straight to its confirmation card. More: My
              // policies, which lists them all (B4). The count is the whole
              // list, no longer the first twenty. The label counts the
              // overdue ones and the detail names each deadline (E1).
              <AttentionRow
                href={pendingAcks.length === 1 ? `/doc/${pendingAcks[0].id}#confirm-reading` : "/compliance"}
                icon={<ClipboardCheck className="h-4 w-4" aria-hidden />}
                label={`${pendingAcks.length} ${pendingAcks.length === 1 ? "policy needs" : "policies need"} your read confirmation${
                  overdueAcks > 0 ? ` · ${overdueAcks} overdue` : ""
                }`}
                detail={pendingAcks
                  .slice(0, 3)
                  .map(
                    (d) =>
                      `${d.space_icon} ${d.title}${
                        d.due_at ? ` (due ${formatDate(d.due_at, settingsForUser(appSettings, user))})` : ""
                      }`
                  )
                  .join(" · ")}
              />
            )}
            {reviewsDue.length > 0 && (
              <AttentionRow
                href={`/doc/${reviewsDue[0].id}`}
                icon={<CalendarClock className="h-4 w-4" aria-hidden />}
                label={`${reviewsDue.length} document${reviewsDue.length === 1 ? "" : "s"} due for content review`}
                detail={reviewsDue
                  .slice(0, 3)
                  .map((d) => `${d.title} (due ${formatDate(d.review_due_at, settingsForUser(appSettings, user))})`)
                  .join(" · ")}
              />
            )}
            {openSuggestions.length > 0 && (
              <AttentionRow
                href="/review"
                icon={<MessageSquareText className="h-4 w-4" aria-hidden />}
                label={`${openSuggestions.length} open suggestion${openSuggestions.length === 1 ? "" : "s"} from readers`}
              />
            )}
          </div>
        </section>
      )}

      {/* Pick up where you left off */}
      {(continueDocs.length > 0 || myDrafts.length > 0) && (
        <section className="mb-6">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Pick up where you left off</h2>
          <div className="card-grid gap-3 [--card-min:20rem]">
            {myDrafts.map((d) => (
              <Link
                key={`draft-${d.id}`}
                href={`/doc/${d.id}/edit`}
                className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-surface p-3.5 shadow-xs transition hover:border-compass-300 hover:shadow-md"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-600">
                  <PenLine className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900 group-hover:text-compass-700">
                    {d.title}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                    <StatusBadge status="draft" />
                    {d.space_icon} {d.space_name} · {timeAgo(d.updated_at)}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-compass-500" aria-hidden />
              </Link>
            ))}
            {continueDocs.map((d) => (
              <Link
                key={d.id}
                href={`/doc/${d.id}`}
                className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-surface p-3.5 shadow-xs transition hover:border-compass-300 hover:shadow-md"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-lg" style={{ backgroundColor: `${d.space_color}1a` }}>
                  {d.space_icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900 group-hover:text-compass-700">
                    {d.title}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {d.space_name} · updated {timeAgo(d.updated_at)}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-compass-500" aria-hidden />
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function AttentionRow({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  detail?: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-2.5 px-4 py-2.5 transition hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
    >
      <span className="mt-0.5 text-amber-700 dark:text-amber-300">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-amber-900 dark:text-amber-200">{label}</span>
        {detail && (
          <span className="mt-0.5 block truncate text-xs text-amber-700/80 dark:text-amber-300/70">
            {detail}
          </span>
        )}
      </span>
      <ChevronRight
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-400 group-hover:text-amber-600 dark:group-hover:text-amber-300"
        aria-hidden
      />
    </Link>
  );
}

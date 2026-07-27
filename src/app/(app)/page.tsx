import Link from "next/link";
import { getAppSettings } from "@/lib/settings-store";
import { PageContainer } from "@/components/PageWidth";
import {
  listSpaces,
  listRecentDocuments,
  listRecentlyViewedBy,
  listDraftsByAuthor,
  listPendingAcksFor,
  listActiveAnnouncementsFor,
  listDashboardNewslettersFor,
  listChangeRequests,
  listSuggestions,
} from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { spaceScopeFor } from "@/lib/access";
import { featureEnabled } from "@/lib/ee";
import { roleAtLeast } from "@/lib/types";
import { timeAgo } from "@/lib/ui";
import { AnnouncementBoard } from "@/components/AnnouncementBoard";
import { NewsletterBoard } from "@/components/NewsletterBoard";
import { DashboardGreeting } from "@/components/DashboardGreeting";
import { StatusBadge } from "@/components/Badges";
import { listReviewsDue } from "@/lib/reviews";
import { formatDate } from "@/lib/format";
import {
  Search,
  Sparkles,
  CalendarClock,
  ClipboardCheck,
  GitPullRequest,
  MessageSquareText,
  FileClock,
  PenLine,
  ChevronRight,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const isEditor = roleAtLeast(user.role, "editor");
  const isApprover = roleAtLeast(user.role, "approver");
  const scope = await spaceScopeFor(user);
  const appSettings = await getAppSettings();
  const pendingAcks = (await featureEnabled("policy_ack"))
    ? await listPendingAcksFor(user.id, scope)
    : [];
  const [
    spaces,
    recent,
    recentlyViewed,
    myDrafts,
    announcements,
    newsletters,
    reviewsDue,
    pendingCrs,
    openSuggestions,
  ] = await Promise.all([
    listSpaces(scope),
    listRecentDocuments(8, isEditor, scope),
    listRecentlyViewedBy(user.id, scope, isEditor, 5),
    isEditor ? listDraftsByAuthor(user.name, scope, 3) : Promise.resolve([]),
    listActiveAnnouncementsFor(user.id),
    listDashboardNewslettersFor(user.id),
    isEditor ? listReviewsDue(scope, 12) : Promise.resolve([]),
    isApprover ? listChangeRequests("pending", scope) : Promise.resolve([]),
    isEditor ? listSuggestions("open", scope) : Promise.resolve([]),
  ]);

  // Drafts also appear in "recently viewed" — don't show them twice.
  const draftIds = new Set(myDrafts.map((d) => d.id));
  const continueDocs = recentlyViewed.filter((d) => !draftIds.has(d.id)).slice(0, 4);

  const attentionCount =
    pendingAcks.length + reviewsDue.length + pendingCrs.length + openSuggestions.length;

  return (
    <PageContainer>
      {/* Greeting + hero search */}
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <DashboardGreeting name={user.name || user.username} />
        <Link
          href="/search"
          className="group flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-surface px-4 py-3 text-slate-400 shadow-xs transition hover:border-compass-300 hover:shadow-md sm:w-96"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <span className="flex-1 truncate text-sm">
            Search, or ask {appSettings.company_name} anything…
          </span>
          <Sparkles className="h-4 w-4 shrink-0 text-compass-500" aria-hidden />
          <kbd className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 sm:block">
            ⌘K
          </kbd>
        </Link>
      </header>

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
              <AttentionRow
                href={`/doc/${pendingAcks[0].id}`}
                icon={<ClipboardCheck className="h-4 w-4" aria-hidden />}
                label={`${pendingAcks.length} document${pendingAcks.length === 1 ? " needs" : "s need"} your read confirmation`}
                detail={pendingAcks
                  .slice(0, 3)
                  .map((d) => `${d.space_icon} ${d.title}`)
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
                  .map((d) => `${d.title} (due ${formatDate(d.review_due_at, appSettings)})`)
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
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Pick up where you left off</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

      {/* Two columns: activity + spaces */}
      <div className="mb-8 grid grid-cols-1 gap-8 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Latest in your spaces</h2>
          </div>
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-surface shadow-xs">
            {recent.map((d) => (
              <Link
                key={d.id}
                href={`/doc/${d.id}`}
                className="group flex items-center gap-3 px-4 py-3 transition first:rounded-t-xl last:rounded-b-xl hover:bg-slate-50"
              >
                <span className="text-lg" aria-hidden>
                  {d.space_icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-900 group-hover:text-compass-700">
                      {d.title}
                    </span>
                    {d.status === "draft" && <StatusBadge status="draft" />}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {d.author} · {d.space_name} · {timeAgo(d.updated_at)}
                  </span>
                </span>
                <FileClock className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-compass-400" aria-hidden />
              </Link>
            ))}
            {recent.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                Nothing here yet — publish a first document to get the ball rolling.
              </p>
            )}
          </div>
        </section>

        <section className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Spaces</h2>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {spaces.map((s) => (
              <Link
                key={s.id}
                href={`/spaces/${s.slug}`}
                className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-surface p-3.5 shadow-xs transition hover:border-compass-300 hover:shadow-md"
              >
                <div
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-xl"
                  style={{ backgroundColor: `${s.color}1a` }}
                >
                  {s.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-slate-900 group-hover:text-compass-700">
                    {s.name}
                  </h3>
                  <p className="truncate text-xs text-slate-500">
                    {s.doc_count} document{s.doc_count === 1 ? "" : "s"}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-compass-500" aria-hidden />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </PageContainer>
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

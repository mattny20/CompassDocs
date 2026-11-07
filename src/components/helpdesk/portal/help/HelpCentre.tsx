// The customer portal's help centre (Helpdesk 1.19.4, C3, mock h1 at 1440
// and 390). Server-safe pieces: the home (a full-width compass-50 hero with
// "How can we help?" and the search, the categories as cards with their
// article counts, then "Still need help?"), the article list a category or
// a search shows, and the "Still need help?" card. Everything they show
// came through lib/helpdesk/help-centre publicHelpArticles.

import Link from "next/link";
import { BookOpen, ChevronLeft } from "lucide-react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/form";
import { articleCount, categoryHref, type HelpSuggestion } from "@/lib/helpdesk/help-centre-shared";
import { HelpSearch } from "./HelpSearch";
import { ArticleLink } from "./HelpBits";

export interface HomeCategory {
  key: string;
  name: string;
  count: number;
}

/** The hero: a full-width band (the portal's main pads its sides; this cancels them). */
function Hero({ children }: { children: React.ReactNode }) {
  return <section className="-mx-4 border-b border-slate-200 bg-compass-50 px-4 py-10 text-center sm:-mx-6 sm:px-6 sm:py-11 print:hidden">{children}</section>;
}

export function HelpCentreHome({ categories, canRaise }: { categories: HomeCategory[]; canRaise: boolean }) {
  return (
    <>
      <Hero>
        <h1 className="text-2xl font-bold text-slate-900 sm:text-[1.65rem]">How can we help?</h1>
        <HelpSearch className="mt-4" />
      </Hero>
      <div className="mx-auto mt-7 w-full max-w-5xl">
        {categories.length === 0 ? (
          <EmptyState icon={<BookOpen />} title="No articles yet" body="Articles appear here once they're published. Search above, or raise a request." />
        ) : (
          <nav aria-label="Categories">
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3.5">
              {categories.map((c) => (
                <li key={c.key} className="min-w-0">
                  <Link
                    href={categoryHref(c.key)}
                    className="block h-full rounded-xl border border-slate-200 bg-surface p-4 transition hover:border-compass-300 hover:bg-slate-50"
                  >
                    <span className="block hyphens-auto break-words font-semibold text-slate-900">{c.name}</span>
                    <span className="mt-0.5 block text-[0.8rem] text-slate-500">{articleCount(c.count)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <StillNeedHelp canRaise={canRaise} className="mt-6" />
      </div>
    </>
  );
}

/** "Still need help? Raise a request and we'll get back to you by email." with New request; nothing when nothing can be raised. */
export function StillNeedHelp({ canRaise, className = "" }: { canRaise: boolean; className?: string }) {
  if (!canRaise) return null;
  return (
    <div className={`flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-4 py-4 sm:px-5 print:hidden ${className}`.trim()}>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-slate-900">Still need help?</h2>
        <p className="text-sm text-slate-500">Raise a request and we&apos;ll get back to you by email.</p>
      </div>
      <Button href="/support/new" className="shrink-0">
        New request
      </Button>
    </div>
  );
}

/** Back to the help centre's home. */
export function HelpBack({ href = "/support", label = "Help centre" }: { href?: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-compass-700 print:hidden">
      <ChevronLeft className="h-4 w-4" aria-hidden /> {label}
    </Link>
  );
}

/** Articles as rows: the title (a link) and its summary, with the category when asked. */
export function ArticleRows({ articles, label, showCategory = false }: { articles: HelpSuggestion[]; label: string; showCategory?: boolean }) {
  return (
    <ul className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" aria-label={label}>
      {articles.map((a) => (
        <li key={a.id} className="border-b border-slate-100 last:border-b-0">
          <ArticleLink href={a.href} className="flex items-start gap-2.5 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5">
            <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
            <span className="min-w-0">
              <span className="block font-semibold text-slate-900">{a.title}</span>
              {(a.summary || showCategory) && (
                <span className="mt-0.5 line-clamp-2 block text-sm text-slate-500">
                  {showCategory && <span className="font-medium text-slate-600">{a.category}</span>}
                  {showCategory && a.summary && " · "}
                  {a.summary}
                </span>
              )}
            </span>
          </ArticleLink>
        </li>
      ))}
    </ul>
  );
}

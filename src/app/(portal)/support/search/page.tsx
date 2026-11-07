// /support/search?q=…: the help centre's results (Helpdesk 1.19.4, C3),
// what Enter in the search box opens (a plain GET form, so it works
// without script). Only public articles (lib/helpdesk/help-centre
// publicHelpArticles). Never indexed. 40 searches a minute per network
// address, as the suggestions route. The search is counted only when the
// help centre's own form opened this page (Sec-Fetch-Site same-origin, the
// suggestions route's rule), never from a link elsewhere or an unfurl bot,
// and with the tab's journey (?j=), so it joins the suggestions' row
// rather than counting twice.

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/form";
import { ipFrom } from "@/lib/audit";
import { getPortalSettings, offeredTypes, portalOriginRejection } from "@/lib/helpdesk/portal";
import { HC_LIMITS, cleanHelpQuery, getHelpCentreSettings, helpCentreOpen, helpSearchLimited, searchHelpCentre } from "@/lib/helpdesk/help-centre";
import { ArticleRows, HelpBack, StillNeedHelp } from "@/components/helpdesk/portal/help/HelpCentre";
import { HelpSearch } from "@/components/helpdesk/portal/help/HelpSearch";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search", robots: { index: false, follow: false, nocache: true } };

export default async function HelpSearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
  if (!(await helpCentreOpen({ hc, portal }))) notFound();
  const sp = await searchParams;
  const q = cleanHelpQuery(typeof sp.q === "string" ? sp.q : "");
  const asked = new Request("http://portal.invalid/", { headers: await headers() });
  const ip = ipFrom(asked) ?? "unknown";
  const fromHere = portalOriginRejection(asked) === null;
  const limited = q.length >= 2 && helpSearchLimited(ip);
  const [results, types] = await Promise.all([
    q.length >= 2 && !limited ? searchHelpCentre(q, { journey: sp.j, source: "home", limit: HC_LIMITS.results, record: fromHere }, { hc, portal }) : Promise.resolve([]),
    offeredTypes(portal),
  ]);
  const canRaise = types.length > 0;
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <HelpBack />
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Search the help centre</h1>
      <HelpSearch initial={q} wide className="mt-4" />
      <div className="mt-5">
        {limited ? (
          <p className="notice-warn rounded-lg border px-4 py-3 text-sm">Too many searches right now. Wait a moment and try again.</p>
        ) : q.length < 2 ? null : results.length === 0 ? (
          <EmptyState icon={<SearchX />} title="No articles match that" body="Try other words, or raise a request and we'll help." />
        ) : (
          <>
            <p className="mb-2 text-sm text-slate-500" role="status">
              {results.length === 1 ? "1 article" : `${results.length} articles`} for “{q}”
            </p>
            <ArticleRows articles={results} label="Search results" showCategory />
          </>
        )}
      </div>
      <StillNeedHelp canRaise={canRaise} className="mt-6" />
    </div>
  );
}

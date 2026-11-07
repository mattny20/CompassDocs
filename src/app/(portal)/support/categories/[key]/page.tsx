// /support/categories/<key>: one help centre category's articles
// (Helpdesk 1.19.4, C3). A key is "c<id>" (a space's folder) or "s<id>"
// (a space's documents in no folder). Only what the help centre's rule
// makes public (lib/helpdesk/help-centre publicHelpArticles); a category
// with nothing public, switched off, or unknown is the portal's 404. The
// count is the true one; past the first 300 the page says how many it
// shows and points to search.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPortalSettings, offeredTypes } from "@/lib/helpdesk/portal";
import { articleCount, getHelpCentreSettings, helpCentreCategory, toSuggestion } from "@/lib/helpdesk/help-centre";
import { ArticleRows, HelpBack, StillNeedHelp } from "@/components/helpdesk/portal/help/HelpCentre";

export const dynamic = "force-dynamic";

type Params = Promise<{ key: string }>;

async function load(key: string) {
  const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
  const category = await helpCentreCategory(key, { hc, portal });
  return category ? { category, hc, portal } : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  try {
    const got = await load((await params).key);
    if (got) return { title: got.category.name, robots: got.hc.indexing ? { index: true, follow: true } : { index: false, follow: false, nocache: true } };
  } catch {
    /* no database: the layout's defaults */
  }
  return { title: "Help centre" };
}

export default async function HelpCategoryPage({ params }: { params: Params }) {
  const got = await load((await params).key);
  if (!got) notFound();
  const { category, portal } = got;
  const canRaise = (await offeredTypes(portal)).length > 0;
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <HelpBack />
      <h1 className="mt-2 text-2xl font-bold text-slate-900">{category.name}</h1>
      <p className="mt-1 text-sm text-slate-500">{articleCount(category.total)}</p>
      <div className="mt-4">
        <ArticleRows articles={category.articles.map(toSuggestion)} label={`Articles in ${category.name}`} />
      </div>
      {category.total > category.articles.length && (
        <p className="mt-3 text-sm text-slate-500" role="note">
          Showing the first {category.articles.length.toLocaleString("en")} of {category.total.toLocaleString("en")}. Search to find the others.
        </p>
      )}
      <StillNeedHelp canRaise={canRaise} className="mt-6" />
    </div>
  );
}

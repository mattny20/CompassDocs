// /support/articles/<id>-<slug>: one help centre article (Helpdesk 1.19.4,
// C3). Anyone who can reach the portal reads it while the portal and the
// help centre are on; no sign-in. Only an article the help centre's rule
// makes public (lib/helpdesk/help-centre publicHelpArticles) opens; any
// other number is the portal's 404, like one that does not exist. The
// body (comments removed: publicBody) is drawn by the sanitising renderer
// the share and public pages use (MarkdownView), and every address in it
// is decided on the parsed tree by helpCentreUrl (rewriteUrl). No
// author, tags, comments or history. A wrong or missing slug redirects to
// the article's own address.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { Paperclip } from "lucide-react";
import { MarkdownView } from "@/components/MarkdownView";
import { getPortalSettings, offeredTypes } from "@/lib/helpdesk/portal";
import { headers } from "next/headers";
import { articleIdFrom, categoryHref, getHelpCentreSettings, helpCentreArticle, helpCentreOwnHosts, helpCentreUrl } from "@/lib/helpdesk/help-centre";
import { HelpBack, StillNeedHelp } from "@/components/helpdesk/portal/help/HelpCentre";
import { ArticleDate } from "@/components/helpdesk/portal/help/HelpBits";

export const dynamic = "force-dynamic";

type Params = Promise<{ article: string }>;

async function load(segment: string) {
  const id = articleIdFrom(segment);
  if (!id) return null;
  const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
  const article = await helpCentreArticle(id, { hc, portal });
  return article ? { article, hc, portal } : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  try {
    const got = await load((await params).article);
    if (got) {
      return {
        title: got.article.title,
        description: got.article.summary || undefined,
        robots: got.hc.indexing ? { index: true, follow: true } : { index: false, follow: false, nocache: true },
      };
    }
  } catch {
    /* no database: the layout's defaults */
  }
  return { title: "Help centre" };
}

export default async function HelpArticlePage({ params }: { params: Params }) {
  const segment = (await params).article;
  const got = await load(segment);
  if (!got) notFound();
  const { article, portal } = got;
  if (`/support/articles/${segment}` !== article.href) permanentRedirect(article.href);
  const canRaise = (await offeredTypes(portal)).length > 0;
  const h = await headers();
  const urls = { publicHrefs: new Map(article.links), ownHosts: await helpCentreOwnHosts(`${h.get("x-forwarded-host") ?? ""},${h.get("host") ?? ""}`) };
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 text-sm text-slate-500 print:hidden">
        <HelpBack />
        <span aria-hidden>/</span>
        <Link href={categoryHref(article.category.key)} className="hover:text-compass-700">
          {article.category.name}
        </Link>
      </nav>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{article.title}</h1>
      <p className="mt-1.5 text-sm text-slate-500">
        Updated <ArticleDate value={article.updated_at} />
      </p>
      {article.summary && <p className="mt-4 text-lg leading-relaxed text-slate-600">{article.summary}</p>}
      <article className="doc-read mt-5 rounded-xl border border-slate-200 bg-surface p-5 shadow-xs sm:p-8 print:border-0 print:p-0 print:shadow-none">
        <MarkdownView content={article.body} docKey={`hc-${article.id}`} dropTitle={article.title} rewriteUrl={(url) => helpCentreUrl(url, urls)} />
      </article>
      {article.files.length > 0 && (
        <section className="mt-5 rounded-xl border border-slate-200 bg-surface p-5 shadow-xs print:hidden">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Paperclip className="h-4 w-4 text-slate-500" aria-hidden /> Files
          </h2>
          <ul className="space-y-1">
            {article.files.map((f) => (
              <li key={f.id}>
                <a href={f.href} className="link text-sm font-medium">
                  {f.filename}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <StillNeedHelp canRaise={canRaise} className="mt-6" />
    </div>
  );
}

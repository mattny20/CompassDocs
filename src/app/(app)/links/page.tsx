import Link from "next/link";
import { ExternalLink, SquareArrowOutUpRight } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listLinkCategories, listLinksVisibleTo } from "@/lib/db";
import type { QuickLink } from "@/lib/db";
import { getAppSettings } from "@/lib/settings-store";
import { PageContainer } from "@/components/PageWidth";

export const dynamic = "force-dynamic";

// The Quick links launchpad: admin-curated external shortcuts, grouped by
// category and filtered to what the signed-in user's groups may see.
export default async function LinksPage() {
  const user = await requireUser();
  const [categories, links, settings] = await Promise.all([
    listLinkCategories(),
    listLinksVisibleTo(user.role === "admin" ? "all" : user.id),
    getAppSettings(),
  ]);

  const byCategory = new Map<number | null, QuickLink[]>();
  for (const l of links) {
    const key = l.category_id;
    (byCategory.get(key) ?? byCategory.set(key, []).get(key)!).push(l);
  }
  const sections: { name: string; links: QuickLink[] }[] = [];
  for (const c of categories) {
    const rows = byCategory.get(c.id);
    if (rows?.length) sections.push({ name: c.name, links: rows });
  }
  const uncategorized = byCategory.get(null);
  if (uncategorized?.length) sections.push({ name: "General", links: uncategorized });

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Links</h1>
          <p className="mt-1 text-slate-500">
            Shortcuts to the tools and sites your team uses.
          </p>
        </div>
        {user.role === "admin" && (
          <Link
            href="/admin/links"
            className="shrink-0 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Manage links
          </Link>
        )}
      </div>

      {sections.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          <SquareArrowOutUpRight className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          <p className="font-medium text-slate-600">No links yet</p>
          <p className="mt-1 text-sm">
            {user.role === "admin"
              ? "Add shortcuts to the tools your team uses in Settings → Links."
              : "Your admin hasn't added any shortcuts yet."}
          </p>
        </div>
      )}

      {sections.map((section) => (
        <section key={section.name} className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            {section.name}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.links.map((l) => (
              <a
                key={l.id}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-sm transition hover:border-compass-300 hover:shadow"
              >
                <LinkIcon link={l} brandLogo={settings.logo_url} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-semibold text-slate-800 group-hover:text-compass-700">
                    <span className="truncate">{l.title}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-compass-400" />
                  </span>
                  {l.description && (
                    <span className="mt-0.5 block text-sm text-slate-500 line-clamp-2">
                      {l.description}
                    </span>
                  )}
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </PageContainer>
  );
}

// Icon precedence: cached favicon / custom upload → workspace logo (brand) →
// a letter tile in the accent colour.
function LinkIcon({ link, brandLogo }: { link: QuickLink; brandLogo?: string }) {
  const cls = "h-10 w-10 shrink-0 rounded-lg object-contain bg-white ring-1 ring-slate-100";
  if (link.icon_file && link.icon_mime) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/api/links/icon/${link.id}`} alt="" className={cls} />;
  }
  if (link.icon_type === "brand" && brandLogo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brandLogo} alt="" className={cls} />;
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-compass-100 text-lg font-bold text-compass-700">
      {(link.title.trim()[0] || "?").toUpperCase()}
    </span>
  );
}

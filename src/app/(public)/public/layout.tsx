// Layout for the anonymous public site. Deliberately separate from the (app)
// route group: no session, no sidebar, no user-dependent chrome — just the
// workspace branding, the public spaces, search, and a sign-in link. Every
// page under here is reachable without authentication, so this layout (plus
// the pages' own checks) IS the security boundary: the master switch 404s
// everything, and pages only ever query visibility='public' + published.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Search } from "lucide-react";
import { getPublicSiteConfig } from "@/lib/public-site";
import { getAppSettings } from "@/lib/settings-store";
import { listPublicSpaces } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [cfg, settings] = await Promise.all([getPublicSiteConfig(), getAppSettings()]);
  return {
    title: { default: `${settings.company_name} — Knowledge Base`, template: `%s — ${settings.company_name}` },
    robots: cfg.indexing ? undefined : { index: false, follow: false },
  };
}

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const cfg = await getPublicSiteConfig();
  if (!cfg.enabled) notFound();

  const [settings, spaces] = await Promise.all([getAppSettings(), listPublicSpaces()]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-4 px-6 py-4">
          <Link href="/public" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={settings.logo_url || "/icon.png"}
              alt=""
              className="h-8 w-8 rounded-lg object-contain"
            />
            <span className="text-lg font-bold text-slate-900">{settings.company_name}</span>
          </Link>

          <form action="/public/search" className="ml-auto flex min-w-[200px] flex-1 sm:max-w-xs">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                name="q"
                placeholder="Search the docs…"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-compass-400 focus:bg-white focus:ring-2 focus:ring-compass-100"
              />
            </div>
          </form>

          <Link
            href="/login"
            className="text-sm font-medium text-slate-500 hover:text-compass-700"
          >
            Sign in
          </Link>
        </div>

        {spaces.length > 1 && (
          <nav className="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-6 pb-3">
            {spaces.map((s) => (
              <Link
                key={s.id}
                href={`/public/${s.slug}`}
                className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-slate-600 hover:bg-slate-100"
              >
                {s.icon} {s.name}
              </Link>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>

      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-400">
        {settings.company_name} knowledge base · powered by{" "}
        <a href="https://compassdocs.io" className="underline hover:text-slate-600">
          CompassDocs
        </a>
      </footer>
    </div>
  );
}

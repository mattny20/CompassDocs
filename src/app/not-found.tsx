import Link from "next/link";
import { buttonClass } from "@/components/Button";
import { BookOpen, FileQuestion, LogIn } from "lucide-react";

// Root fallback for addresses that match no route at all, so they never fall
// through to Next's stock white "404 | This page could not be found" (wrong
// font, no way back, a white slab in dark mode). Outside the app shell there
// is no sidebar to return to, so this centers like the sign-in page — but it
// still inherits the theme variables, so dark mode and the font are right.
//
// Whoever lands here may be a visitor on a dead public link, so the copy is
// neutral (nothing about the Trash or colleagues) and the exits are Sign in
// and, when the public site is on, Browse the knowledge base. The public
// site's own not-found (under (public)) keeps its chrome.

async function publicSiteOn(): Promise<boolean> {
  // A not-found page must render even while the database is unreachable
  // (and during a build without one), so the lookup is best-effort.
  try {
    const { getPublicSiteConfig } = await import("@/lib/public-site");
    return (await getPublicSiteConfig()).enabled;
  } catch {
    return false;
  }
}

export default async function RootNotFound() {
  const browse = await publicSiteOn();
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-surface p-6 text-center shadow-xs">
        <FileQuestion className="mx-auto h-6 w-6 text-compass-600" aria-hidden />
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Page not found</h1>
        <p className="mt-1 text-sm text-slate-500">
          This address doesn&rsquo;t lead anywhere we can show you. It may have moved, or it may
          need you to be signed in.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link href="/login" className={buttonClass("primary")}>
            <LogIn className="h-4 w-4" /> Sign in
          </Link>
          {browse && (
            <Link href="/public" className={buttonClass("secondary")}>
              <BookOpen className="h-4 w-4" /> Browse the knowledge base
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";
import { FileQuestion, House, Search } from "lucide-react";

// Root fallback for addresses that match no route at all, so they never fall
// through to Next's stock white "404 | This page could not be found" (wrong
// font, no way back, a white slab in dark mode). Outside the app shell there
// is no sidebar to return to, so this centers like the sign-in page — but it
// still inherits the theme variables, so dark mode and the font are right.

export default function RootNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-surface p-6 text-center shadow-xs">
        <FileQuestion className="mx-auto h-6 w-6 text-compass-600" aria-hidden />
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Page not found</h1>
        <p className="mt-1 text-sm text-slate-500">
          This address doesn&rsquo;t lead anywhere we can show you.
        </p>
        <p className="mt-4 text-sm text-slate-400">
          It may have been deleted, moved to Trash, or it&rsquo;s in a space you can&rsquo;t see.
          If a colleague sent you the link, ask them to check it still exists.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700"
          >
            <House className="h-4 w-4" /> Back to dashboard
          </Link>
          <Link
            href="/search"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <Search className="h-4 w-4" /> Search documents
          </Link>
        </div>
      </div>
    </div>
  );
}

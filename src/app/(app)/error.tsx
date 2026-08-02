"use client";

// Error boundary for everything inside the app shell. A thrown render/data
// error would otherwise blank the page (or, in production, drop the user on
// Next's stock error screen); here the sidebar, theme and font survive and the
// user gets an honest sentence plus a way to try again.

import { useEffect } from "react";
import Link from "next/link";
import { House, RotateCcw, TriangleAlert } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Surface it in the browser console for support; the message itself is not
  // shown to the user (it can carry internals), the digest is.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
        <TriangleAlert className="h-6 w-6 text-compass-600" /> Something went wrong
      </h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        This page failed to load. Nothing you were viewing has been changed.
      </p>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          We hit an unexpected error while building this page. It&rsquo;s usually temporary —
          trying again often works. If it keeps happening, send your administrator the reference
          below.
        </div>
        {error.digest && (
          <p className="mt-2 text-xs text-slate-400">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700"
          >
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-surface px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <House className="h-4 w-4" /> Back to dashboard
          </Link>
        </div>
      </div>
    </PageContainer>
  );
}

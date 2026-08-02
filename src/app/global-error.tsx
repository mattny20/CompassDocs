"use client";

// Last-resort boundary: catches errors thrown by the root layout itself, so
// it replaces that layout and must render its own <html>/<body>. That also
// means it has to pull in the global stylesheet and re-run the pre-paint
// theme stamp itself — otherwise this page would be the one unstyled white
// slab left in the product.

import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import "./globals.css";

// Same logic as the root layout's THEME_INIT: honor the saved preference (or
// the OS) before first paint so dark mode never flashes white.
const THEME_INIT = `
(function(){try{
  var p = localStorage.getItem('compass-theme') || 'system';
  var dark = p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}catch(e){}})();
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // The inline script above only runs when this page is server-rendered;
    // when React renders it client-side, stamp the theme here instead.
    try {
      const pref = localStorage.getItem("compass-theme") || "system";
      const dark =
        pref === "dark" ||
        (pref !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    } catch {
      /* storage blocked — the light default stands */
    }
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <div className="flex min-h-screen items-center justify-center px-4 py-10">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-surface p-6 text-center shadow-xs">
            <TriangleAlert className="mx-auto h-6 w-6 text-compass-600" aria-hidden />
            <h1 className="mt-2 text-2xl font-bold text-slate-900">Something went wrong</h1>
            <p className="mt-1 text-sm text-slate-500">
              The application failed to start this page.
            </p>
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
              This is usually temporary — reloading often works. If it keeps happening, send your
              administrator the reference below.
            </div>
            {error.digest && (
              <p className="mt-2 text-xs text-slate-400">
                Reference: <span className="font-mono">{error.digest}</span>
              </p>
            )}
            <div className="mt-6 flex justify-center">
              <button
                onClick={reset}
                className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-compass-700"
              >
                <RotateCcw className="h-4 w-4" /> Try again
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}

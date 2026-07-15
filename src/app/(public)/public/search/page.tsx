import Link from "next/link";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { searchDocuments, publicSpaceIds } from "@/lib/db";
import { searchRateLimited } from "@/lib/public-site";

export const dynamic = "force-dynamic";

/**
 * ts_headline copies document text verbatim (it doesn't HTML-escape), so a doc
 * containing raw HTML would otherwise be injected into this anonymous page.
 * Escape everything, then restore only our own <mark> highlight tokens.
 */
function safeSnippet(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

export const metadata: Metadata = {
  title: "Search",
  // Search result pages are never worth indexing, even when the site is.
  robots: { index: false, follow: false },
};

export default async function PublicSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const q = ((await searchParams).q ?? "").trim().slice(0, 200);

  let hits: Awaited<ReturnType<typeof searchDocuments>> = [];
  let limited = false;
  if (q) {
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    limited = searchRateLimited(ip);
    if (!limited) {
      const ids = await publicSpaceIds();
      hits = ids.length ? await searchDocuments(q, 20, false, ids) : [];
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Search</h1>
      {!q && <p className="mt-2 text-slate-500">Type something in the search box above.</p>}

      {limited && (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Too many searches right now — please try again in a minute.
        </p>
      )}

      {q && !limited && (
        <>
          <p className="mt-1 text-slate-500">
            {hits.length} result{hits.length === 1 ? "" : "s"} for “{q}”
          </p>
          <ul className="mt-6 space-y-3">
            {hits.map((h) => (
              <li key={h.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <Link
                  href={`/public/${h.space_slug}/${h.slug}`}
                  className="font-semibold text-compass-700 hover:underline"
                >
                  {h.title}
                </Link>
                <span className="ml-2 text-xs text-slate-400">{h.space_name}</span>
                <p
                  className="mt-1 text-sm text-slate-500 [&_mark]:bg-amber-100 [&_mark]:font-medium"
                  dangerouslySetInnerHTML={{ __html: safeSnippet(h.snippet) }}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

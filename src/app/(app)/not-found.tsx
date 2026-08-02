import Link from "next/link";
import { FileQuestion, House, Search } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";

// Rendered inside the app shell (sidebar, theme, width preference) whenever a
// page under (app) calls notFound() — a trashed document, a space the user
// can't see, a training route behind a disabled feature. Without this, Next's
// stock white "404" replaces the whole product.

export default function AppNotFound() {
  return (
    <PageContainer>
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
        <FileQuestion className="h-6 w-6 text-compass-600" /> Page not found
      </h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        This address doesn&rsquo;t lead anywhere we can show you.
      </p>

      <div className="rounded-xl border border-slate-200 bg-surface px-4 py-10 text-center shadow-xs">
        <p className="mx-auto max-w-lg text-sm text-slate-400">
          It may have been deleted, moved to Trash, or it&rsquo;s in a space you can&rsquo;t see.
          If a colleague sent you the link, ask them to check it still exists and that you have
          access to its space.
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
    </PageContainer>
  );
}

import Link from "next/link";
import { BookOpen, FileQuestion, Search } from "lucide-react";
import { buttonClass } from "@/components/Button";

// A dead link on the public site stays inside the public chrome (the header
// with the logo, spaces and search is the layout's), with exits that work
// for an anonymous visitor.
export default function PublicNotFound() {
  return (
    <div className="mx-auto max-w-standalone px-6 py-16">
      <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-surface p-8 text-center shadow-xs">
        <FileQuestion className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
        <h1 className="mt-3 text-xl font-bold text-slate-900">That page isn&rsquo;t here</h1>
        <p className="mt-1 text-sm text-slate-500">
          It may have been unpublished or moved. Try a search, or start from the front page.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link href="/public" className={buttonClass("primary")}>
            <BookOpen className="h-4 w-4" /> Front page
          </Link>
          <Link href="/public/search" className={buttonClass("secondary")}>
            <Search className="h-4 w-4" /> Search
          </Link>
        </div>
      </div>
    </div>
  );
}

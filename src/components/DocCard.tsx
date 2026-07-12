import Link from "next/link";
import type { DocumentWithSpace } from "@/lib/types";
import { TypeBadge, StatusBadge } from "./Badges";
import { timeAgo } from "@/lib/ui";

export function DocCard({ doc }: { doc: DocumentWithSpace }) {
  return (
    <Link
      href={`/doc/${doc.id}`}
      className="group flex flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-sm transition hover:border-compass-300 hover:shadow-md"
    >
      <div className="mb-2 flex items-center gap-2">
        <TypeBadge type={doc.type} />
        {doc.status === "draft" && <StatusBadge status="draft" />}
      </div>
      <h3 className="line-clamp-2 font-semibold text-slate-900 group-hover:text-compass-700">
        {doc.title}
      </h3>
      <p className="mt-1 line-clamp-2 text-sm text-slate-500">{doc.summary}</p>
      <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-slate-400">
        <span>{doc.space_icon}</span>
        <span className="truncate">{doc.space_name}</span>
        <span>·</span>
        <span className="whitespace-nowrap">{timeAgo(doc.updated_at)}</span>
      </div>
    </Link>
  );
}

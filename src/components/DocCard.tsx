import Link from "next/link";
import type { DocumentWithSpace } from "@/lib/types";
import { TypeBadge, StatusBadge } from "./Badges";
import { Chip } from "./Chip";
import { timeAgo } from "@/lib/ui";

/**
 * A document as a card. Inside a space (`inSpace`) the meta line is the
 * author and the review state — repeating the space's own name on every
 * card said nothing (1.9.3). In cross-space lists (a person's documents) the
 * space name stays, because there it is the distinguishing fact.
 */
export function DocCard({ doc, inSpace = false }: { doc: DocumentWithSpace; inSpace?: boolean }) {
  const due = doc.review_due_at ? new Date(doc.review_due_at) : null;
  const overdue = due !== null && doc.status === "published" && due.getTime() <= Date.now();
  return (
    <Link
      href={`/doc/${doc.id}`}
      className="group flex flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-xs transition hover:border-compass-300 hover:shadow-md"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TypeBadge type={doc.type} />
        {doc.status === "draft" && <StatusBadge status="draft" />}
        {inSpace && overdue && <Chip tone="warn">Review overdue</Chip>}
      </div>
      <h3 className="line-clamp-2 font-semibold text-slate-900 group-hover:text-compass-700">
        {doc.title}
      </h3>
      <p className="mt-1 line-clamp-2 text-sm text-slate-500">{doc.summary}</p>
      <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-slate-500">
        {inSpace ? (
          <span className="truncate">{doc.author}</span>
        ) : (
          <>
            <span>{doc.space_icon}</span>
            <span className="truncate">{doc.space_name}</span>
          </>
        )}
        <span>·</span>
        <span className="whitespace-nowrap">{timeAgo(doc.updated_at)}</span>
      </div>
    </Link>
  );
}

"use client";

// The newsletter workspace list: every piece the user can see, grouped by
// where it sits in the editorial workflow, plus the "New newsletter" entry
// point (creates an empty draft and jumps into the editor).

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Mail, CalendarClock } from "lucide-react";

export interface NewsletterRow {
  id: number;
  subject: string;
  author_name: string;
  status: string;
  audience: string;
  sent_count: number;
  updated_at: string;
  sent_at: string | null;
  scheduled_at: string | null;
}

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: {
    label: "Draft",
    cls: "bg-slate-100 text-slate-600",
  },
  in_review: {
    label: "In review",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  },
  changes_requested: {
    label: "Changes requested",
    cls: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  },
  approved: {
    label: "Approved",
    cls: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300",
  },
  sent: {
    label: "Sent",
    cls: "bg-compass-100 text-compass-700",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

const SECTIONS: { status: string; title: string }[] = [
  { status: "in_review", title: "In review" },
  { status: "changes_requested", title: "Changes requested" },
  { status: "approved", title: "Approved — ready to send" },
  { status: "draft", title: "Drafts" },
  { status: "sent", title: "Sent" },
];

export function NewsletterList({ initial }: { initial: NewsletterRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createDraft() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data?.error || "Couldn't create a draft.");
      return;
    }
    router.push(`/newsletter/${data.newsletter.id}`);
  }

  const anyRows = initial.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Newsletter</h1>
          <p className="mt-1 text-slate-500">
            Draft with the document editor, hand it to an approver for review, then send it
            as a branded email.
          </p>
        </div>
        <button
          onClick={createDraft}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {busy ? "Creating…" : "New newsletter"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!anyRows && (
        <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
          <Mail className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            Nothing here yet — start your first newsletter.
          </p>
        </div>
      )}

      {SECTIONS.map(({ status, title }) => {
        const rows = initial.filter((r) => r.status === status);
        if (rows.length === 0) return null;
        return (
          <div key={status} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
            <h2 className="mb-3 font-semibold text-slate-900">{title}</h2>
            <ul className="divide-y divide-slate-100">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/newsletter/${r.id}`}
                    className="flex items-center gap-3 py-2.5 text-sm hover:bg-slate-50 -mx-2 px-2 rounded-md"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-800">
                        {r.subject || <span className="italic text-slate-400">Untitled</span>}
                      </p>
                      <p className="text-xs text-slate-400">
                        {r.author_name} ·{" "}
                        {new Date(r.sent_at || r.updated_at).toLocaleString()}
                        {r.status === "sent" && r.audience ? ` · ${r.audience}` : ""}
                      </p>
                    </div>
                    {r.status === "sent" && (
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {r.sent_count} sent
                      </span>
                    )}
                    {r.status === "approved" && r.scheduled_at && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-500/20 dark:text-green-300">
                        <CalendarClock className="h-3 w-3" />
                        {new Date(r.scheduled_at).toLocaleString()}
                      </span>
                    )}
                    <StatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

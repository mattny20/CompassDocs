"use client";

// Archived training decks: restore (un-archive) or hard-delete. Kept off the
// main Training tab so long-retired material doesn't clutter the dashboard.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, GraduationCap, LoaderCircle, Trash2, Users } from "lucide-react";
import { useFormatDate } from "./SettingsProvider";
import { EmptyState } from "./form";

interface ArchivedDeck {
  id: number;
  title: string;
  space_name: string;
  space_icon: string;
  archived_at: string | null;
  assigned: number;
  completed: number;
}

export function ArchivedDecks({ decks }: { decks: ArchivedDeck[] }) {
  const router = useRouter();
  const fmt = useFormatDate();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function call(id: number, init: RequestInit) {
    setBusyId(id);
    setError("");
    const res = await fetch(`/api/training/decks/${id}`, init);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Something went wrong.");
    }
    setBusyId(null);
    router.refresh();
  }

  if (!decks.length) {
    return (
      <EmptyState
        icon={<Archive />}
        title="Nothing archived"
        body="Decks you retire from the Training tab are kept here, and can be restored."
        action={{ href: "/training", label: "Back to training", icon: <GraduationCap /> }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="notice-error rounded-lg border px-4 py-2 text-sm">{error}</div>
      )}
      {decks.map((d) => (
        <section
          key={d.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs"
        >
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-900">{d.title}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
              <span>
                {d.space_icon} {d.space_name}
              </span>
              {d.archived_at && <span>· archived {fmt.date(d.archived_at)}</span>}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> {d.completed}/{d.assigned} completed
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              onClick={() =>
                void call(d.id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ archived: false }),
                })
              }
              disabled={busyId === d.id}
              className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {busyId === d.id ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ArchiveRestore className="h-4 w-4" />
              )}
              Restore
            </button>
            <button
              onClick={() => {
                if (
                  confirm(
                    `Permanently delete "${d.title}"? Its assignment and completion history (${d.completed} completions) goes with it. The document itself is untouched. This cannot be undone.`
                  )
                )
                  void call(d.id, { method: "DELETE" });
              }}
              disabled={busyId === d.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}

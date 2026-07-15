"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MarkdownView } from "./MarkdownView";
import type { ChangeRequest, Suggestion } from "@/lib/types";
import { timeAgo } from "@/lib/ui";

export function ReviewClient({
  changeRequests,
  suggestions,
}: {
  changeRequests: ChangeRequest[];
  suggestions: Suggestion[];
}) {
  const router = useRouter();
  const [crs, setCrs] = useState(changeRequests);
  const [sugs, setSugs] = useState(suggestions);
  const [busy, setBusy] = useState<string | null>(null);

  async function reviewCr(id: number, action: "approve" | "reject") {
    setBusy(`cr-${id}`);
    const res = await fetch(`/api/change-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (res.ok) {
      setCrs((prev) => prev.filter((c) => c.id !== id));
      router.refresh();
    } else {
      alert("Action failed.");
    }
  }

  async function reviewSug(id: number, action: "accept" | "dismiss") {
    setBusy(`sg-${id}`);
    const res = await fetch(`/api/suggestions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(null);
    if (res.ok) {
      setSugs((prev) => prev.filter((s) => s.id !== id));
      router.refresh();
    } else {
      alert("Action failed.");
    }
  }

  const empty = crs.length === 0 && sugs.length === 0;
  if (empty) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-surface p-10 text-center text-slate-400">
        🎉 The queue is empty. Nothing to review right now.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {crs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Pending changes ({crs.length})
          </h2>
          <div className="space-y-3">
            {crs.map((cr) => (
              <div key={cr.id} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        {cr.kind === "publish" ? "Publish request" : "Edit"}
                      </span>
                      {cr.target_space_name && (
                        <span
                          className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700"
                          title="Approving also moves the document to this space."
                        >
                          → moves to {cr.target_space_name}
                        </span>
                      )}
                      {cr.space_visibility === "public" && (
                        <span
                          className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                          title="This space is public — approved changes are visible on the internet without signing in."
                        >
                          🌐 Goes public
                        </span>
                      )}
                      <span className="text-xs text-slate-400">{timeAgo(cr.created_at)}</span>
                    </div>
                    <h3 className="font-semibold text-slate-900">{cr.title}</h3>
                    <p className="text-sm text-slate-500">
                      Proposed by {cr.author_name}
                      {cr.document_title ? (
                        <>
                          {" · "}
                          <Link href={`/doc/${cr.document_id}`} className="text-compass-600 hover:underline">
                            view current doc
                          </Link>
                        </>
                      ) : null}
                    </p>
                    {cr.note && <p className="mt-1 text-sm italic text-slate-500">“{cr.note}”</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => reviewCr(cr.id, "approve")}
                      disabled={busy === `cr-${cr.id}`}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => reviewCr(cr.id, "reject")}
                      disabled={busy === `cr-${cr.id}`}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                    >
                      Reject
                    </button>
                  </div>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-medium text-compass-600">
                    Preview proposed content
                  </summary>
                  <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-100 bg-slate-50 p-4">
                    <MarkdownView content={cr.content} />
                  </div>
                </details>
              </div>
            ))}
          </div>
        </section>
      )}

      {sugs.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Suggestions ({sugs.length})
          </h2>
          <div className="space-y-3">
            {sugs.map((sg) => (
              <div key={sg.id} className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm text-slate-700">{sg.body}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      From {sg.author_name} · {timeAgo(sg.created_at)}
                      {sg.document_title ? (
                        <>
                          {" · on "}
                          <Link href={`/doc/${sg.document_id}`} className="text-compass-600 hover:underline">
                            {sg.document_title}
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => reviewSug(sg.id, "accept")}
                      disabled={busy === `sg-${sg.id}`}
                      className="rounded-lg border border-green-200 px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-50 disabled:opacity-60"
                    >
                      Mark done
                    </button>
                    <button
                      onClick={() => reviewSug(sg.id, "dismiss")}
                      disabled={busy === `sg-${sg.id}`}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

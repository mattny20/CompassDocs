"use client";

// "Was this helpful?" at the end of a document. One vote per person,
// changeable; a "No" invites an optional note about what's missing. Votes
// feed analytics and the Content health report.

import { useEffect, useState } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";

interface Summary {
  up: number;
  down: number;
  mine: boolean | null;
}

export function DocFeedback({ docId }: { docId: number }) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [askNote, setAskNote] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${docId}/feedback`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setSum(d as Summary);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [docId]);

  async function vote(helpful: boolean, withNote?: string): Promise<boolean> {
    setBusy(true);
    let ok = false;
    try {
      const res = await fetch(`/api/documents/${docId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ helpful, ...(withNote ? { note: withNote } : {}) }),
      });
      if (res.ok) {
        ok = true;
        setSum((await res.json()) as Summary);
        setThanks(true);
        if (helpful) setAskNote(false);
      }
    } catch {}
    setBusy(false);
    return ok;
  }

  if (!sum) return null;

  const btn = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
      active
        ? "border-compass-300 bg-compass-50 text-compass-700"
        : "border-slate-200 text-slate-600 hover:bg-slate-50"
    }`;

  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-slate-700">Was this helpful?</span>
        <button
          type="button"
          onClick={() => vote(true)}
          disabled={busy}
          aria-pressed={sum.mine === true}
          className={btn(sum.mine === true)}
        >
          <ThumbsUp className="h-4 w-4" aria-hidden /> Yes
          {sum.up > 0 && <span className="text-xs text-slate-400">{sum.up}</span>}
        </button>
        <button
          type="button"
          onClick={() => {
            setAskNote(true);
            void vote(false);
          }}
          disabled={busy}
          aria-pressed={sum.mine === false}
          className={btn(sum.mine === false)}
        >
          <ThumbsDown className="h-4 w-4" aria-hidden /> No
          {sum.down > 0 && <span className="text-xs text-slate-400">{sum.down}</span>}
        </button>
        {thanks && !askNote && <span className="text-sm text-green-600">Thanks!</span>}
      </div>
      {askNote && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            // Keep the form (and the typed note) unless the POST succeeded.
            const ok = await vote(false, note.trim());
            if (ok) {
              setAskNote(false);
              setNote("");
            }
          }}
        >
          <label htmlFor="fb-note" className="sr-only">
            What's missing or wrong?
          </label>
          <input
            id="fb-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="What's missing or wrong? (optional)"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-compass-400"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}

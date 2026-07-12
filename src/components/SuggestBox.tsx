"use client";

import { useState } from "react";

export function SuggestBox({ documentId }: { documentId: number }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setState("saving");
    setError("");
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to submit.");
      setState("done");
      setBody("");
    } catch (e: any) {
      setError(e.message);
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="mt-8 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
        ✓ Thanks — your suggestion was sent to the review queue.{" "}
        <button className="font-medium underline" onClick={() => setState("idle")}>
          Suggest another
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 border-t border-slate-100 pt-6">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
        >
          💡 Suggest an edit
        </button>
      ) : (
        <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-4">
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Suggest an improvement
          </label>
          <p className="mb-2 text-xs text-slate-400">
            Describe what should change. An approver will review it.
          </p>
          {error && <div className="mb-2 text-sm text-red-600">{error}</div>}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            autoFocus
            rows={3}
            placeholder="e.g. Step 4 is out of date — the canary now bakes for 15 minutes, not 10."
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-compass-400 focus:ring-2 focus:ring-compass-100"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="submit"
              disabled={state === "saving"}
              className="rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
            >
              {state === "saving" ? "Sending…" : "Send suggestion"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

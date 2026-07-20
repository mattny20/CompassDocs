"use client";

// Share-link card in the doc side panel (staff with edit rights, feature
// admin-gated): create a tokenized read-only link with optional expiry,
// copy it, see how often it's been opened, revoke or regenerate it.

import { useEffect, useState } from "react";
import { Check, Copy, Link as LinkIcon, LoaderCircle, RefreshCw, Share2, X } from "lucide-react";

interface ShareInfo {
  token: string;
  url: string;
  expires_at: string | null;
  view_count: number;
}

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Never expires" },
  { value: "7", label: "Expires in 7 days" },
  { value: "30", label: "Expires in 30 days" },
  { value: "90", label: "Expires in 90 days" },
];

export function ShareCard({
  docId,
  initial,
  isPublished,
}: {
  docId: number;
  initial: ShareInfo | null;
  isPublished: boolean;
}) {
  const [share, setShare] = useState<ShareInfo | null>(initial);
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  // Origin resolves client-side only, keeping SSR and hydration in sync.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  async function create() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/documents/${docId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_days: expiry ? Number(expiry) : null }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not create the link.");
      return;
    }
    setShare((await res.json()).share);
  }

  async function revoke() {
    if (!confirm("Revoke this share link? Anyone holding it loses access immediately.")) return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/documents/${docId}/share`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) setShare(null);
  }

  async function copy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(`${location.origin}${share.url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <Share2 className="h-3.5 w-3.5" aria-hidden /> Share link
      </h2>
      {!isPublished ? (
        <p className="text-sm text-slate-400">Publish this document to share it externally.</p>
      ) : share ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <input
              readOnly
              value={`${origin}${share.url}`}
              onFocus={(e) => e.target.select()}
              aria-label="Share link URL"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-600"
            />
            <button
              onClick={copy}
              title={copied ? "Copied!" : "Copy link"}
              aria-label="Copy share link"
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Anyone with this link can read the current published version.{" "}
            {share.expires_at
              ? `Expires ${new Date(share.expires_at).toLocaleDateString()}.`
              : "Never expires."}{" "}
            Opened {share.view_count} time{share.view_count === 1 ? "" : "s"}.
          </p>
          <div className="flex gap-2">
            <button
              onClick={create}
              disabled={busy}
              title="Replace with a fresh link (the old one stops working)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              <RefreshCw className="h-3 w-3" /> Regenerate
            </button>
            <button
              onClick={revoke}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              <X className="h-3 w-3" /> Revoke
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-400">
            Create a read-only link anyone can open — no account needed. Unguessable, never
            indexed, revocable here at any time.
          </p>
          <select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            aria-label="Link expiry"
            className="w-full rounded-lg border border-slate-200 bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-compass-400"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={create}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-compass-700 disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LinkIcon className="h-4 w-4" />}
            Create share link
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  );
}

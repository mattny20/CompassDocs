"use client";

// Settings → Public site. The master switch for anonymous access: which is a
// deliberate two-step with space visibility (a space marked Public shows
// nothing until this is on, and vice versa).

import { useState } from "react";
import { Globe, ExternalLink } from "lucide-react";

type PublicSpace = { id: number; name: string; slug: string; doc_count: number };

export function PublicSitePanel({
  initial,
  publicSpaces,
}: {
  initial: { enabled: boolean; indexing: boolean };
  publicSpaces: PublicSpace[];
}) {
  const [config, setConfig] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(patch: { enabled?: boolean; indexing?: boolean }) {
    setSaving(true);
    setError("");
    const res = await fetch("/api/admin/public-site", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || "Could not save.");
      return;
    }
    setConfig((await res.json()).config);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Public site</h2>
        <p className="mt-1 text-sm text-slate-500">
          Serve the published documents of <strong>Public</strong> spaces to anyone on the
          internet — no sign-in — at{" "}
          <code className="rounded bg-slate-100 px-1 text-xs">/public</code>. Useful for a
          customer help center or public policies. Drafts, suggestions, and every other space
          stay behind the login.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={saving}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-compass-600"
          />
          <span>
            <span className="font-medium text-slate-900">Enable the public site</span>
            <span className="block text-sm text-slate-500">
              Off by default. When off, every <code className="text-xs">/public</code> page
              returns 404 regardless of space settings — nothing is exposed.
            </span>
          </span>
        </label>

        <label className={`mt-4 flex items-start gap-3 ${config.enabled ? "cursor-pointer" : "opacity-50"}`}>
          <input
            type="checkbox"
            checked={config.indexing}
            disabled={saving || !config.enabled}
            onChange={(e) => save({ indexing: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-compass-600"
          />
          <span>
            <span className="font-medium text-slate-900">Allow search engines</span>
            <span className="block text-sm text-slate-500">
              When off, public pages carry a <code className="text-xs">noindex</code> directive —
              reachable by anyone with the link, but not listed in search results.
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-sm">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Globe className="h-4 w-4 text-emerald-600" />
          Public spaces
        </h3>
        {publicSpaces.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No space is marked Public yet. Set one under{" "}
            <a href="/admin/spaces" className="font-medium text-compass-700 underline">
              Settings → Spaces
            </a>{" "}
            → Edit → <em>Who can see it</em> → <em>Public</em>.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {publicSpaces.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium text-slate-800">{s.name}</span>
                <span className="text-xs text-slate-400">
                  {s.doc_count} published article{s.doc_count === 1 ? "" : "s"}
                </span>
                {config.enabled && (
                  <a
                    href={`/public/${s.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-compass-700 hover:underline"
                  >
                    View <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-slate-400">
        Anonymous visitors can browse and search public spaces only. AI answers, the API, and
        the Claude connector always require an account. Public search is rate-limited.
      </p>
    </div>
  );
}

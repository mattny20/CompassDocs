"use client";

// Settings → Public site. The master switch for anonymous access: which is a
// deliberate two-step with space visibility (a space marked Public shows
// nothing until this is on, and vice versa).

import { useState } from "react";
import { Globe, ExternalLink } from "lucide-react";
import { toast } from "@/components/Toasts";
import { Toggle } from "@/components/form";

type PublicSpace = { id: number; name: string; slug: string; doc_count: number };

export function PublicSitePanel({
  initial,
  publicSpaces,
}: {
  initial: { enabled: boolean; indexing: boolean; shareLinks: boolean };
  publicSpaces: PublicSpace[];
}) {
  const [config, setConfig] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function save(
    patch: { enabled?: boolean; indexing?: boolean; shareLinks?: boolean },
    okText: string
  ) {
    setSaving(true);
    const res = await fetch("/api/admin/public-site", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    if (!res.ok) {
      toast("error", (await res.json().catch(() => ({}))).error || "Could not save.");
      return;
    }
    setConfig((await res.json()).config);
    toast("ok", okText);
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-slate-500">
          Serve the published documents of <strong>Public</strong> spaces to anyone on the
          internet — no sign-in — at{" "}
          <code className="rounded-sm bg-slate-100 px-1 text-xs">/public</code>. Useful for a
          customer help center or public policies. Drafts, suggestions, and every other space
          stay behind the login.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <Toggle
          label="Enable the public site"
          help={
            <>
              Off by default. When off, every <code className="text-xs">/public</code> page
              returns 404 regardless of space settings — nothing is exposed.
            </>
          }
          checked={config.enabled}
          disabled={saving}
          onChange={(next) =>
            save(
              { enabled: next },
              next ? "Public site enabled." : "Public site disabled."
            )
          }
        />

        <div className={`mt-4 ${config.enabled ? "" : "opacity-50"}`}>
          <Toggle
            label="Allow search engines"
            help={
              <>
                When off, public pages carry a <code className="text-xs">noindex</code> directive —
                reachable by anyone with the link, but not listed in search results.
              </>
            }
            checked={config.indexing}
            disabled={saving || !config.enabled}
            onChange={(next) =>
              save(
                { indexing: next },
                next ? "Search engines allowed." : "Search engines disallowed."
              )
            }
          />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <Toggle
          label="Allow public share links"
          help={
            <>
              Off by default. When on, editors can create a tokenized read-only link to a
              single published document (<code className="text-xs">/share/…</code>) — share
              one SOP with a customer without opening a whole space. Links are unguessable,
              never indexed by search engines, revocable, and can carry an expiry. Turning
              this off disables every existing link immediately.
            </>
          }
          checked={config.shareLinks}
          disabled={saving}
          onChange={(next) =>
            save(
              { shareLinks: next },
              next ? "Public share links enabled." : "Public share links disabled."
            )
          }
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
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

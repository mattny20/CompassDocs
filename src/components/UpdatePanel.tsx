"use client";

import { useEffect, useState } from "react";

interface ReleaseInfo {
  tag: string;
  name: string;
  url: string;
  publishedAt: string | null;
  notes: string;
}
interface UpdateStatus {
  current: string;
  imageTag: string | null;
  oneClick: boolean;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  upgradeCommand: string;
  sourceTarballUrl: string | null;
  sourceUpgradeCommand: string | null;
  releasesUrl: string;
  note?: string;
  checkedAt: string;
}

export function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // idle → updating (poked the updater; app may vanish) → done (came back newer)
  const [updating, setUpdating] = useState<"idle" | "updating" | "done" | "timeout">("idle");
  const [updatedTo, setUpdatedTo] = useState("");

  async function updateNow() {
    if (!status?.latest) return;
    if (
      !confirm(
        `Update to ${status.latest.tag}? The app pulls the new image and restarts — usually under a minute. Everyone's work is saved continuously, but in-flight edits should be saved first.`
      )
    )
      return;
    setError("");
    const res = await fetch("/api/admin/update", { method: "POST" });
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error || "Couldn't start the update.");
      return;
    }
    setUpdating("updating");
    const fromVersion = status.current;
    const deadline = Date.now() + 6 * 60_000;
    // Poll until the app answers with a NEW version (it goes dark while the
    // container restarts — fetch failures along the way are expected).
    const poll = async () => {
      if (Date.now() > deadline) return setUpdating("timeout");
      try {
        const r = await fetch("/api/admin/version", { cache: "no-store" });
        if (r.ok) {
          const s: UpdateStatus = await r.json();
          if (s.current !== fromVersion) {
            setStatus(s);
            setUpdatedTo(s.current);
            setUpdating("done");
            return;
          }
        }
      } catch {
        /* restarting */
      }
      setTimeout(poll, 5_000);
    };
    setTimeout(poll, 8_000);
  }

  async function load(refresh = false) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/version${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) throw new Error("Could not check for updates.");
      setStatus(await res.json());
    } catch (e: any) {
      setError(e?.message || "Could not check for updates.");
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copy() {
    if (!status) return;
    navigator.clipboard?.writeText(status.upgradeCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  const available = status?.updateAvailable;

  return (
    <div
      className={`rounded-xl border p-4 shadow-xs ${
        available ? "border-compass-300 bg-compass-50/60" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-slate-900">Version &amp; updates</h3>
          {status && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              v{status.current}
            </span>
          )}
          {available && (
            <span className="rounded-full bg-compass-600 px-2 py-0.5 text-xs font-semibold text-white">
              Update available
            </span>
          )}
          {status && !available && !status.note && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
              ✓ Up to date
            </span>
          )}
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? "Checking…" : "Check now"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {status && !error && (
        <div className="mt-3 space-y-3 text-sm">
          {updating === "updating" && (
            <div className="flex items-center gap-2 rounded-lg bg-compass-50 px-3 py-2.5 text-sm text-compass-800 dark:bg-compass-950/40">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-compass-500 border-t-transparent" aria-hidden />
              Updating — pulling the new image and restarting. This page will confirm when the
              app is back (usually under a minute).
            </div>
          )}
          {updating === "done" && (
            <div className="notice-ok rounded-lg px-3 py-2.5 text-sm font-medium">
              ✓ Updated to v{updatedTo}. Reload the page to pick up the new interface.
            </div>
          )}
          {updating === "timeout" && (
            <div className="notice-warn rounded-lg px-3 py-2.5 text-sm">
              The update was triggered but the app hasn&rsquo;t come back newer after several
              minutes. Check <code className="font-mono">docker compose logs updater</code> on the
              server — the image may still be downloading, or the container tag may be pinned.
            </div>
          )}
          {available && status.latest && updating === "idle" ? (
            <>
              <p className="text-slate-700">
                <span className="font-semibold text-compass-700">{status.latest.tag}</span> is
                available — you&rsquo;re on <span className="font-medium">v{status.current}</span>.
              </p>
              {status.oneClick && (
                <button
                  onClick={updateNow}
                  className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white shadow-xs transition hover:bg-compass-700"
                >
                  Update to {status.latest.tag} now
                </button>
              )}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    Update (from your install folder)
                  </span>
                  <button onClick={copy} className="text-xs font-medium text-compass-600 hover:underline">
                    {copied ? "Copied ✓" : "Copy"}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-[#0f172a] px-3 py-2.5 font-mono text-xs text-[#f1f5f9]">
                  {status.upgradeCommand}
                </pre>
              </div>
              {status.imageTag && status.imageTag !== "latest" && (
                <p className="notice-warn rounded-lg px-3 py-2 text-xs">
                  You&rsquo;ve pinned <code className="font-mono">COMPASSDOCS_VERSION={status.imageTag}</code>.
                  Bump it to <code className="font-mono">{status.latest.tag.replace(/^v/, "")}</code> (or{" "}
                  <code className="font-mono">latest</code>) in your <code className="font-mono">.env</code> before running the command.
                </p>
              )}
              {status.sourceUpgradeCommand && (
                <details className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-slate-600">
                    Not running Docker? Update from the source tarball
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-[#0f172a] px-3 py-2.5 font-mono text-xs text-[#f1f5f9]">
                    {status.sourceUpgradeCommand}
                  </pre>
                  <p className="mt-2 text-xs text-slate-500">
                    {status.sourceTarballUrl && (
                      <>
                        Or download the{" "}
                        <a
                          href={status.sourceTarballUrl}
                          className="font-medium text-compass-600 hover:underline"
                        >
                          release tarball
                        </a>{" "}
                        directly.{" "}
                      </>
                    )}
                    The database schema migrates itself on start — your data is preserved.
                  </p>
                </details>
              )}
              <a
                href={status.latest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-block font-medium text-compass-600 hover:underline"
              >
                Read the release notes →
              </a>
            </>
          ) : updating !== "idle" ? null : (
            <p className="text-slate-600">
              {status.note
                ? status.note
                : status.latest
                  ? `You're running the latest version (${status.latest.tag}).`
                  : "You're up to date."}{" "}
              <a
                href={status.releasesUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-compass-600 hover:underline"
              >
                View releases →
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

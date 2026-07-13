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
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  upgradeCommand: string;
  releasesUrl: string;
  note?: string;
  checkedAt: string;
}

export function UpdatePanel() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

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
      className={`rounded-xl border p-4 shadow-sm ${
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
          {available && status.latest ? (
            <>
              <p className="text-slate-700">
                <span className="font-semibold text-compass-700">{status.latest.tag}</span> is
                available — you&rsquo;re on <span className="font-medium">v{status.current}</span>.
              </p>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    Update (from your install folder)
                  </span>
                  <button onClick={copy} className="text-xs font-medium text-compass-600 hover:underline">
                    {copied ? "Copied ✓" : "Copy"}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2.5 font-mono text-xs text-slate-100">
                  {status.upgradeCommand}
                </pre>
              </div>
              {status.imageTag && status.imageTag !== "latest" && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  You&rsquo;ve pinned <code className="font-mono">COMPASSDOCS_VERSION={status.imageTag}</code>.
                  Bump it to <code className="font-mono">{status.latest.tag.replace(/^v/, "")}</code> (or{" "}
                  <code className="font-mono">latest</code>) in your <code className="font-mono">.env</code> before running the command.
                </p>
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
          ) : (
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

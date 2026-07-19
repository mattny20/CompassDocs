"use client";

import { useState } from "react";
import { Copy, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import { timeAgo } from "@/lib/ui";

// Admin card for SCIM provisioning (enterprise): shows the tenant/base URL to
// paste into Entra, generates/rotates the bearer token (displayed once), and
// toggles the endpoint on and off.

export interface ScimStatus {
  licensed: boolean;
  enabled: boolean;
  token_set: boolean;
  last_request_at: string | null;
  base_url: string;
}

export function ScimPanel({ initial }: { initial: ScimStatus }) {
  const [status, setStatus] = useState<ScimStatus>(initial);
  const [freshToken, setFreshToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  async function call(method: "POST" | "PATCH", body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/scim", {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Request failed.");
      if (data.token) setFreshToken(data.token);
      setStatus({
        licensed: data.licensed,
        enabled: data.enabled,
        token_set: data.token_set,
        last_request_at: data.last_request_at,
        base_url: data.base_url,
      });
    } catch (e: any) {
      setError(e.message || "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, which: "url" | "token") {
    void navigator.clipboard?.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
            <KeyRound className="h-4 w-4 text-compass-600" /> SCIM provisioning
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-900/50">
              Enterprise
            </span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Let Microsoft Entra ID create, update, and deactivate CompassDocs accounts
            automatically. Users sign in with SSO; removed employees are disabled here within
            Entra&rsquo;s provisioning cycle.
          </p>
        </div>
        {status.licensed && status.token_set && (
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(e) => call("PATCH", { enabled: e.target.checked })}
              className="h-4 w-4 accent-compass-600"
            />
            Enabled
          </label>
        )}
      </div>

      {!status.licensed ? (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-800/40">
          SCIM provisioning requires an enterprise license that includes the{" "}
          <code className="text-xs">scim</code> entitlement.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Tenant URL (paste into Entra provisioning)
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 dark:bg-slate-800/40">
                {status.base_url}
              </code>
              <button
                onClick={() => copy(status.base_url, "url")}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <Copy className="h-3.5 w-3.5" /> {copied === "url" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {freshToken ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-800/60 dark:bg-emerald-950/40">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                Secret token — copy it now, it won&rsquo;t be shown again
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-white/70 px-2.5 py-1.5 text-xs text-slate-800 dark:bg-slate-900/60 dark:text-slate-100">
                  {freshToken}
                </code>
                <button
                  onClick={() => copy(freshToken, "token")}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300"
                >
                  <Copy className="h-3.5 w-3.5" /> {copied === "token" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => {
                  if (
                    status.token_set &&
                    !confirm(
                      "Generate a new token? The current token stops working immediately — update Entra with the new one."
                    )
                  ) {
                    return;
                  }
                  void call("POST");
                }}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60"
              >
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {status.token_set ? "Rotate secret token" : "Generate secret token"}
              </button>
              <span className="text-xs text-slate-400">
                {status.token_set
                  ? status.last_request_at
                    ? `Entra last called ${timeAgo(status.last_request_at)}.`
                    : "Token set — waiting for the first request from Entra."
                  : "No token yet — generate one and paste it into Entra as the Secret Token."}
              </span>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <p className="text-xs text-slate-400">
            Users are provisioned as Viewers and sign in via SSO. Entra deletes deactivate the
            account here (content and history are kept). Group provisioning stays with Entra
            group sync — see the{" "}
            <a
              href="https://docs.compassdocs.io/admin/scim/"
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-compass-600 hover:underline"
            >
              setup guide
            </a>
            .
          </p>
        </div>
      )}
    </section>
  );
}

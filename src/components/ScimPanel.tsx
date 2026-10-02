"use client";

import { useState } from "react";
import { Spinner } from "@/components/Spinner";
import { EnterpriseBadge } from "@/components/Chip";
import { buttonClass } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { CopyButton } from "@/components/CopyButton";
import { KeyRound, RefreshCw } from "lucide-react";
import { timeAgo } from "@/lib/ui";
import { Toggle } from "@/components/form";
import { LicenseGate } from "@/components/LicenseGate";
import { toast } from "@/components/Toasts";

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

  async function call(method: "POST" | "PATCH", body?: unknown) {
    setBusy(true);
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
      toast("error", e.message || "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-surface p-5 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
            <KeyRound className="h-4 w-4 text-compass-600" /> SCIM provisioning
            <EnterpriseBadge />
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Let Microsoft Entra ID create, update, and deactivate CompassDocs accounts
            automatically. Users sign in with SSO; removed employees are disabled here within
            Entra&rsquo;s provisioning cycle.
          </p>
        </div>
        {status.licensed && status.token_set && (
          <div className="shrink-0">
            <Toggle
              label="Enabled"
              checked={status.enabled}
              disabled={busy}
              onChange={(next) => void call("PATCH", { enabled: next })}
            />
          </div>
        )}
      </div>

      {!status.licensed ? (
        // Settings → SSO is an admin page, so the viewer can open License too.
        <LicenseGate feature="SCIM provisioning" entitlement="scim" canManage className="mt-3" />
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Tenant URL (paste into Entra provisioning)
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                {status.base_url}
              </code>
              <CopyButton text={status.base_url} label="Copy" size="sm" />
            </div>
          </div>

          {freshToken ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-800/60 dark:bg-emerald-950/40">
              <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                Secret token — copy it now, it won&rsquo;t be shown again
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-surface/70 px-2.5 py-1.5 text-xs text-slate-800">
                  {freshToken}
                </code>
                <CopyButton text={freshToken} label="Copy" size="sm" />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={async () => {
                  if (
                    status.token_set &&
                    !(await confirmDialog({
                      title: "Generate a new token?",
                      body: "The current token stops working immediately — update Entra with the new one.",
                      confirmLabel: "Generate",
                      danger: true,
                    }))
                  ) {
                    return;
                  }
                  void call("POST");
                }}
                disabled={busy}
                className={buttonClass("primary")}
              >
                {busy ? (
                  <Spinner />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {status.token_set ? "Rotate secret token" : "Generate secret token"}
              </button>
              <span className="text-xs text-slate-500">
                {status.token_set
                  ? status.last_request_at
                    ? `Entra last called ${timeAgo(status.last_request_at)}.`
                    : "Token set — waiting for the first request from Entra."
                  : "No token yet — generate one and paste it into Entra as the Secret Token."}
              </span>
            </div>
          )}
          <p className="text-xs text-slate-500">
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

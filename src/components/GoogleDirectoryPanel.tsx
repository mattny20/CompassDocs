"use client";

// Settings → Directory → Google Workspace.
//
// Deliberately its own panel beside the Microsoft one rather than a merged
// "provider" form: the two need different fields, and the setup steps they walk
// an admin through are different enough that one combined wizard would be
// mostly conditionals. Both can be connected at once — each provider owns the
// people it synced, so neither removes the other's.

import { useState } from "react";
import { CheckCircle2, Copy, Loader2, Plug, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "@/components/Toasts";
import { DangerAction, DangerZone, Field, TextInput, Toggle, controlClass } from "@/components/form";

export interface GoogleState {
  enabled: boolean;
  bundled: boolean;
  has_service_account: boolean;
  service_account_client_id: string;
  admin_email: string;
  customer_id: string;
  group: string;
  include_suspended: boolean;
  photos: boolean;
  configured: boolean;
  scopes: string[];
  last_sync: { at: string; ok: boolean; count?: number; error?: string } | null;
}

const primary =
  "inline-flex items-center gap-1.5 rounded-lg bg-compass-600 px-3 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-compass-700 disabled:opacity-50";
const secondary =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50";

export function GoogleDirectoryPanel({ initial }: { initial: GoogleState }) {
  const [state, setState] = useState(initial);
  const [key, setKey] = useState("");
  const [adminEmail, setAdminEmail] = useState(initial.admin_email);
  const [customerId, setCustomerId] = useState(initial.customer_id);
  const [group, setGroup] = useState(initial.group);
  const [busy, setBusy] = useState("");
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null);

  async function save() {
    setBusy("save");
    try {
      const res = await fetch("/api/admin/directory/google", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // "" means "leave the stored key alone" — the field is blank on load
          // because the key is never sent back to the browser.
          service_account: key,
          admin_email: adminEmail,
          customer_id: customerId,
          group,
          include_suspended: state.include_suspended,
          photos: state.photos,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast("error", data.error || "Could not save.");
      else {
        setState(data);
        setKey("");
        setProbe(null);
        toast("ok", "Google Workspace settings saved.");
      }
    } catch {
      toast("error", "Could not save.");
    }
    setBusy("");
  }

  async function post(path: string, label: string, body?: unknown) {
    setBusy(label);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      setBusy("");
      if (!res.ok) {
        toast("error", data.error || `${label} failed.`);
        return null;
      }
      return data;
    } catch {
      setBusy("");
      toast("error", `${label} failed.`);
      return null;
    }
  }

  async function runProbe() {
    const data = await post("/api/ee/google/probe", "probe");
    if (data) setProbe({ ok: Boolean(data.ok), detail: String(data.detail ?? "") });
  }

  async function runSync() {
    const data = await post("/api/ee/google/sync", "sync");
    if (!data) return;
    // A tripped removal brake is a success with a caveat: the updates applied.
    // Reporting it as a failure would send someone hunting the wrong problem.
    if (data.warning) toast("error", data.warning);
    else toast("ok", `Synced ${data.count} ${data.count === 1 ? "person" : "people"}.`);
    const fresh = await fetch("/api/admin/directory/google");
    if (fresh.ok) setState(await fresh.json());
  }

  async function importGroups() {
    const data = await post("/api/ee/google/groups/sync", "groups");
    if (!data) return;
    const skipped = data.skippedNoAccount
      ? ` ${data.skippedNoAccount} member${data.skippedNoAccount === 1 ? "" : "s"} had no CompassDocs account and were skipped.`
      : "";
    toast("ok", `${data.matched} group(s) synced, ${data.created} created.${skipped}`);
  }

  async function disconnect() {
    if (!confirm("Remove the Google Workspace connection? Synced people stay in the directory.")) return;
    setBusy("disconnect");
    const res = await fetch("/api/admin/directory/google", { method: "DELETE" });
    setBusy("");
    if (!res.ok) return toast("error", "Could not disconnect.");
    setState(await res.json());
    setAdminEmail("");
    setProbe(null);
    toast("ok", "Disconnected.");
  }

  if (!state.bundled) {
    return (
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 text-lg font-semibold text-slate-900">Google Workspace sync</h3>
        <p className="text-sm text-slate-500">
          Directory sync is an enterprise feature. This build is the community edition.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 text-lg font-semibold text-slate-900">Google Workspace sync</h3>
        <p className="mb-3 max-w-2xl text-sm text-slate-500">
          Fills the directory from your Workspace account. It can run alongside Microsoft 365 —
          each provider owns the people it synced, so connecting one never removes the other&rsquo;s.
        </p>

        {!state.enabled && (
          <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Your licence doesn&rsquo;t include directory sync. You can configure it, but syncs will
            be refused.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Service-account key (JSON)"
            help={
              state.has_service_account
                ? "A key is stored. Paste a new one only to replace it."
                : "Paste the whole key file downloaded from the Google Cloud console."
            }
          >
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={4}
              placeholder={state.has_service_account ? "•••••••• (stored)" : "{ … }"}
              className={controlClass(false, "font-mono text-xs")}
            />
          </Field>
          <div className="space-y-3">
            <Field
              label="Administrator to impersonate"
              help="Required — a service account has no directory of its own to read."
            >
              <TextInput
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@yourdomain.com"
              />
            </Field>
            <Field label="Customer ID" help="Leave as my_customer unless you manage several accounts.">
              <TextInput value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Only sync this group (optional)" help="A group email address. Blank syncs everyone.">
            <TextInput
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="staff@yourdomain.com"
            />
          </Field>
          <div className="space-y-2 pt-5">
            <Toggle
              checked={state.photos}
              onChange={(v) => setState({ ...state, photos: v })}
              label="Fetch profile photos"
            />
            <Toggle
              checked={state.include_suspended}
              onChange={(v) => setState({ ...state, include_suspended: v })}
              label="Include suspended accounts"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={save} disabled={busy !== ""}>
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save
          </button>
          <button
            type="button"
            className={secondary}
            onClick={runProbe}
            disabled={busy !== "" || !state.configured}
          >
            <Plug className="h-4 w-4" aria-hidden /> Test connection
          </button>
          <button
            type="button"
            className={secondary}
            onClick={runSync}
            disabled={busy !== "" || !state.configured}
          >
            {busy === "sync" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}{" "}
            Sync people now
          </button>
          <button
            type="button"
            className={secondary}
            onClick={importGroups}
            disabled={busy !== "" || !state.configured}
          >
            Import groups
          </button>
        </div>

        {probe && (
          <p
            className={`mt-3 flex items-start gap-1.5 rounded-lg p-2 text-sm ${
              probe.ok
                ? "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-200"
                : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200"
            }`}
          >
            {probe.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            )}
            {probe.detail}
          </p>
        )}

        {state.last_sync && (
          <p className="mt-3 text-sm text-slate-500">
            Last sync {state.last_sync.ok ? "succeeded" : "failed"}
            {state.last_sync.count !== undefined ? ` — ${state.last_sync.count} people` : ""}
            {state.last_sync.error ? `: ${state.last_sync.error}` : "."}
          </p>
        )}
      </div>

      {state.has_service_account && (
        <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
          <h3 className="mb-1 text-lg font-semibold text-slate-900">Authorise in Google</h3>
          <p className="mb-3 max-w-2xl text-sm text-slate-500">
            In the Google Admin console, go to <strong>Security → API controls → Domain-wide
            delegation</strong> and add a client with the ID and scopes below. Both are shown for
            copying — the delegation form wants the scopes comma-separated, and one wrong character
            produces an error that doesn&rsquo;t say which scope.
          </p>
          <CopyRow label="Client ID" value={state.service_account_client_id} />
          <CopyRow label="Scopes" value={state.scopes.join(",")} mono />
        </div>
      )}

      {state.has_service_account && (
        <DangerZone>
          <DangerAction
            label="Disconnect Google Workspace"
            description="Removes the stored key and impersonation target. People already synced stay in the directory."
          >
            <button
              type="button"
              onClick={disconnect}
              disabled={busy !== ""}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Disconnect
            </button>
          </DangerAction>
        </DangerZone>
      )}
    </div>
  );
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-2">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      <div className="flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200 ${
            mono ? "font-mono" : ""
          }`}
        >
          {value || "—"}
        </code>
        <button
          type="button"
          data-tt={`Copy ${label.toLowerCase()}`}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            navigator.clipboard?.writeText(value);
            toast("ok", `${label} copied.`);
          }}
          className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
        >
          <Copy className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

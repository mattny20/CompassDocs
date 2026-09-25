"use client";

// Microsoft 365 (Entra) directory sync: the app registration, the junk
// filters, and the sync itself with its brake. One page of the directory
// settings, alongside the Google panel.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MsDeviceSetup } from "@/components/MsDeviceSetup";
import { Field, TextInput, Toggle } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { SyncReport } from "@/lib/directory";
import { useFormatDate } from "@/components/SettingsProvider";

interface GraphState {
  enabled: boolean; // bundled AND licensed
  bundled: boolean;
  tenant: string;
  client_id: string;
  has_secret: boolean;
  secret_expires?: string;
  group: string;
  include_guests: boolean;
  require_title: boolean;
  require_phone: boolean;
  photos: boolean;
  last_sync: {
    at: string;
    ok: boolean;
    count?: number;
    error?: string;
    blocked?: { doomed: number; total: number };
  } | null;
}

export function MicrosoftSyncPanel({ graph, report }: { graph: GraphState; report: SyncReport | null }) {
  const router = useRouter();
  const fmt = useFormatDate();
  const [g, setG] = useState(graph);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  if (!g.bundled) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        <p className="font-semibold text-slate-800">Microsoft 365 directory sync</p>
        <p className="mt-1">
          Automatically fill this directory from your Microsoft Entra tenant — an{" "}
          <span className="font-medium">Enterprise</span> feature. See{" "}
          <a href="https://compassdocs.io/pricing" className="font-medium text-compass-600 hover:underline">
            pricing
          </a>{" "}
          or add people by hand under People.
        </p>
      </div>
    );
  }

  if (!g.enabled) {
    return (
      <div className="notice-warn rounded-xl border p-4 text-sm">
        <p className="font-semibold">Microsoft 365 directory sync isn&rsquo;t licensed.</p>
        <p className="mt-1">
          This Enterprise build supports it, but your license doesn&rsquo;t include the{" "}
          <code className="font-mono">directory_sync</code> entitlement — check{" "}
          <a href="/admin/license" className="font-medium underline">Settings → License</a>.
        </p>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    const res = await fetch("/api/admin/directory/graph", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant: g.tenant,
        client_id: g.client_id,
        ...(secret ? { client_secret: secret } : {}),
        group: g.group,
        include_guests: g.include_guests,
        require_title: g.require_title,
        require_phone: g.require_phone,
        photos: g.photos,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    if (data?.state) setG(data.state);
    setSecret("");
    toast("ok", "Microsoft 365 sync settings saved.");
  }

  async function syncNow(allowRemovals = false) {
    setSyncing(true);
    const res = await fetch("/api/ee/directory/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow_removals: allowRemovals }),
    });
    const data = await res.json().catch(() => ({}));
    setSyncing(false);
    if (!res.ok) {
      toast("error", data?.error || "Sync failed.");
      return;
    }
    // The brake tripping is a success with a caveat — the upserts committed.
    if (data?.warning) toast("error", data.warning);
    else toast("ok", `Synced ${data?.count ?? "?"} people from Microsoft 365.`);
    const fresh = await fetch("/api/admin/directory/graph");
    if (fresh.ok) setG(await fresh.json());
    router.refresh();
  }

  async function syncAllowingRemovals() {
    const b = g.last_sync?.blocked;
    if (!b) return;
    if (
      !confirm(
        `Remove ${b.doomed} people who are no longer in the tenant? They will be deleted ` +
          `from the directory. Manual entries are not affected.`
      )
    )
      return;
    await syncNow(true);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-slate-900">Microsoft 365 sync</h3>
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/50 dark:text-violet-300">Enterprise</span>
      </div>
      <p className="mb-3 text-sm text-slate-500">
        Register an app in Microsoft Entra with the <code className="font-mono">User.Read.All</code>{" "}
        application permission (admin-consented), then enter its details here.
      </p>

      <MsDeviceSetup
        startUrl="/api/ee/directory/setup/start"
        pollUrl="/api/ee/directory/setup/poll"
        refreshUrl="/api/admin/directory/graph"
        blurb="Signs you in once as a tenant admin, creates the app registration with User.Read.All + GroupMember.Read.All, grants admin consent, and fills in the details below."
        doneMessage="Done — the Entra app was created, consented, and the settings below were filled in. Hit “Sync now” to run the first sync."
        onDone={(state) => {
          setG(state);
          setSecret("");
        }}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tenant ID">
          <TextInput value={g.tenant} onChange={(e) => setG({ ...g, tenant: e.target.value })} placeholder="00000000-0000-…" spellCheck={false} />
        </Field>
        <Field label="Client ID">
          <TextInput value={g.client_id} onChange={(e) => setG({ ...g, client_id: e.target.value })} placeholder="app registration id" spellCheck={false} />
        </Field>
        <Field
          label={
            <>
              Client secret {g.has_secret && !secret ? <span className="text-green-600">(stored ✓ — paste to replace)</span> : ""}
            </>
          }
          help={
            g.secret_expires && g.has_secret && !secret
              ? `Expires ${g.secret_expires} — set a reminder to rotate it.`
              : undefined
          }
        >
          <TextInput type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={g.has_secret ? "••••••••" : "secret value"} autoComplete="off" />
        </Field>
      </div>

      <div className="mt-3 max-w-md">
        <Field
          label={
            <>
              Limit to an Entra group <span className="text-slate-400">(optional — group object ID)</span>
            </>
          }
        >
          <TextInput value={g.group} onChange={(e) => setG({ ...g, group: e.target.value })} placeholder="leave blank to sync the whole tenant" spellCheck={false} />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-600">
        <Toggle label="Exclude guest accounts" checked={!g.include_guests} onChange={(next) => setG({ ...g, include_guests: !next })} />
        <Toggle label="Require a job title" checked={g.require_title} onChange={(next) => setG({ ...g, require_title: next })} />
        <Toggle label="Require a phone number" checked={g.require_phone} onChange={(next) => setG({ ...g, require_phone: next })} />
        <Toggle label="Sync profile photos" checked={g.photos} onChange={(next) => setG({ ...g, photos: next })} />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-compass-600 px-4 py-2 text-sm font-semibold text-white hover:bg-compass-700 disabled:opacity-60">
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={() => syncNow()} disabled={syncing || !g.tenant || !g.client_id || !(g.has_secret || secret)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50" data-tt={!g.tenant || !g.client_id ? "Save the tenant, client ID, and secret first" : ""} aria-label={!g.tenant || !g.client_id ? "Save the tenant, client ID, and secret first" : ""}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {g.last_sync?.blocked && (
        <div className="notice-warn mt-3 rounded-lg border p-3 text-sm">
          <p className="font-medium">
            {g.last_sync.blocked.doomed} of {g.last_sync.blocked.total} synced people are no
            longer in the tenant — more than half, so they were left in place.
          </p>
          <p className="mt-1.5">
            Usually a group filter pointing somewhere unexpected, or consent that lapsed. If
            the removals are right, allow them once — syncing again on its own will keep
            stopping here.
          </p>
          <button
            type="button"
            onClick={syncAllowingRemovals}
            disabled={syncing}
            className="mt-2 rounded-lg border border-current/40 px-3 py-1.5 font-medium hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/10"
          >
            {syncing ? "Syncing…" : `Sync and remove the ${g.last_sync.blocked.doomed}`}
          </button>
        </div>
      )}

      {g.last_sync && (
        <p className={`mt-3 text-xs ${g.last_sync.ok ? "text-slate-400" : "text-red-500"}`}>
          Last sync {fmt.dateTime(g.last_sync.at)} —{" "}
          {g.last_sync.ok ? `${g.last_sync.count} people` : `failed: ${g.last_sync.error}`}
          {report && g.last_sync.ok ? (
            <>
              {" · "}
              {report.records} with stored records
              {report.adopted ? ` · adopted ${report.adopted} hand-typed ${report.adopted === 1 ? "entry" : "entries"}` : ""}
            </>
          ) : null}
        </p>
      )}
      {report?.unresolved?.length ? (
        <div className="notice-warn mt-2 rounded-lg border p-3 text-xs">
          <p className="font-medium">Some people references didn&rsquo;t match anyone:</p>
          <ul className="mt-1 list-disc pl-4">
            {report.unresolved.map((u) => (
              <li key={u.field}>
                <span className="font-mono">{u.field}</span>: {u.count} unresolved — e.g. {u.samples.join(", ")}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-slate-500">
            Usually someone the sync filters excluded, or an address that isn&rsquo;t the person&rsquo;s primary email. They are retried on every sync.
          </p>
        </div>
      ) : null}
    </div>
  );
}

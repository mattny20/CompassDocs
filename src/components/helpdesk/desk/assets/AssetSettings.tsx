"use client";

// Desk settings → Integrations → Snipe-IT, Microsoft Intune and Asset
// settings (1.20.2: three pages off the Integrations hub; until then one
// "Assets" page held all three). What follows describes the parts.
//
// Assets (1.19.3; mock-up i3): where devices come from, so
// agents can link them to tickets and see each one's history. One source in
// 1.19.3, Snipe-IT: its address (https only) and API key (stored encrypted,
// never shown again: the field only says one is saved and offers Replace),
// what solving does (nothing / offer a maintenance record), Test connection
// (the typed values, or the saved ones) and Sync now (a full sync; the page
// polls while it runs). The "Who sees assets" card holds "Agents can search
// all assets". One Save for the page. GET/PUT /api/helpdesk/admin/assets,
// POST …/test and …/sync (settings.manage).
//
// 1.19.4: Microsoft Intune (mock-up i3). 1.20.2: Intune has its own app
// registration (tenant, application (client) ID, client secret; the secret
// is stored sealed and only ever shown as saved), entered and tested on its
// page; Connect signs in with them before anything is saved. An install
// connected before 1.20.2 keeps using the Microsoft 365 directory sync's
// app, and the page says so, until its own credentials are entered.

import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop, Lock, Package, PlugZap, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { Field, FormError, TextInput, Toggle, controlClass } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RadioCards } from "@/components/PolicyFields";
import { RelativeTime } from "@/components/RelativeTime";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { INTUNE_PERMISSION, type HdAssetOnSolve, type HdAssetSettingsView } from "@/lib/helpdesk/assets-shared";
import { INTEGRATIONS_HUB } from "@/lib/helpdesk/integrations-hub-shared";
import { ApiError, getJson, sendJson } from "../api";

const URL_ = "/api/helpdesk/admin/assets";
const BACK = { href: INTEGRATIONS_HUB, label: "Integrations" };
type Part = "snipeit" | "intune" | "access";

/** Integrations → Snipe-IT. */
export function SnipeItSettings() {
  return <AssetSettings part="snipeit" />;
}
/** Integrations → Microsoft Intune. */
export function IntuneSettings() {
  return <AssetSettings part="intune" />;
}
/** Integrations → Asset settings (who sees assets). */
export function AssetAccessSettings() {
  return <AssetSettings part="access" />;
}

interface Form {
  url: string;
  api_key: string;
  on_solve: HdAssetOnSolve;
  agents_search_all: boolean;
}

const formOf = (v: HdAssetSettingsView): Form => ({ url: v.snipeit.url, api_key: "", on_solve: v.snipeit.on_solve, agents_search_all: v.agents_search_all });

function AssetSettings({ part }: { part: Part }) {
  const [view, setView] = useState<HdAssetSettingsView | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "sync" | "disconnect">("");
  const [replacing, setReplacing] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(f));
  useLeaveGuard(dirty, hasUnsavedChanges);

  const apply = useCallback(
    (v: HdAssetSettingsView, resetForm: boolean) => {
      setView(v);
      if (resetForm) {
        const next = formOf(v);
        setF(next);
        setReplacing(false);
        markClean(JSON.stringify(next));
      }
    },
    [markClean]
  );

  useEffect(() => {
    // Only the live run's answer fills the form: a superseded load (React runs this twice in
    // development) arriving late must never reset what the admin has typed since.
    let live = true;
    getJson<HdAssetSettingsView>(URL_, "Couldn't load the asset settings.")
      .then((v) => live && apply(v, true))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [apply]);

  // While a sync runs, look again every few seconds (the form is left alone).
  const running = !!view?.snipeit.sync.running || !!view?.intune.sync.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      getJson<HdAssetSettingsView>(URL_)
        .then((v) => apply(v, false))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [running, apply]);

  const header =
    part === "snipeit" ? (
      <PageHeader back={BACK} icon={<Package />} title="Snipe-IT" subtitle="Where devices come from, so agents can link them to tickets and see each one's history." />
    ) : part === "intune" ? (
      <PageHeader back={BACK} icon={<Laptop />} title="Microsoft Intune" subtitle="Managed devices with their compliance, matched to people by their account's address and to Snipe-IT by serial." />
    ) : (
      <PageHeader back={BACK} icon={<SlidersHorizontal />} title="Asset settings" subtitle="What holds for every asset source." />
    );
  if (error && !view) return <PageContainer>{header}<p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!view || !f) return <PageContainer>{header}<LoadingRow className="py-10" /></PageContainer>;

  const set = (patch: Partial<Form>) => {
    markDirty();
    setF({ ...f, ...patch });
  };
  const s = view.snipeit;
  const connected = !!s.url && s.key_set;
  const urlChanged = f.url.trim().replace(/\/+$/, "") !== s.url;

  async function save() {
    if (!f) return;
    setBusy("save");
    try {
      const body: Record<string, unknown> = { url: f.url, on_solve: f.on_solve, agents_search_all: f.agents_search_all };
      if (f.api_key.trim()) body.api_key = f.api_key;
      const v = await sendJson<HdAssetSettingsView>(URL_, "PUT", body, "Couldn't save the asset settings.");
      apply(v, true);
      toast("ok", "Asset settings saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    if (!f) return;
    setBusy("test");
    try {
      const r = await sendJson<{ ok: boolean; total?: number; error?: string }>(
        `${URL_}/test`,
        "POST",
        { url: f.url, ...(f.api_key.trim() ? { api_key: f.api_key } : {}) },
        "Couldn't test the connection."
      );
      if (r.ok) toast("ok", `Connected to Snipe-IT: ${(r.total ?? 0).toLocaleString()} ${r.total === 1 ? "asset" : "assets"}.`);
      else toast("error", r.error || "Couldn't connect to Snipe-IT.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function sync() {
    if (dirty) {
      toast("error", "Save your changes first, then sync.");
      return;
    }
    setBusy("sync");
    try {
      const r = await sendJson<{ ok: boolean | null; seen: number; error: string | null; running: boolean; settings: HdAssetSettingsView }>(`${URL_}/sync`, "POST", {}, "Couldn't sync.");
      apply(r.settings, false);
      if (r.running) toast("ok", "Syncing. This page updates when it's done.");
      else if (r.ok) toast("ok", `Synced ${r.seen.toLocaleString()} ${r.seen === 1 ? "asset" : "assets"} from Snipe-IT.`);
      else toast("error", r.error || "The sync failed.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    const ok = await confirmDialog({
      title: "Disconnect Snipe-IT?",
      body: "The address and API key are removed and syncing stops. Assets already linked to tickets stay linked, as they were last synced.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (ok !== true) return;
    setBusy("disconnect");
    try {
      const v = await sendJson<HdAssetSettingsView>(URL_, "PUT", { disconnect: true }, "Couldn't disconnect.");
      apply(v, true);
      toast("ok", "Snipe-IT disconnected.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const state = s.sync.running
    ? { tone: "info" as const, chip: "Syncing", line: <>Syncing now · {s.sync.count.toLocaleString()} assets so far</> }
    : !connected
      ? { tone: "neutral" as const, chip: "Not connected", line: <>Add the address and an API key to start.</> }
      : s.sync.ok === false
        ? { tone: "warn" as const, chip: "Sync failed", line: <>{s.sync.error || "The last sync failed."}</> }
        : {
            tone: "ok" as const,
            chip: "Connected",
            line: (
              <>
                Connected · {s.sync.count.toLocaleString()} {s.sync.count === 1 ? "asset" : "assets"}
                {s.sync.at ? (
                  <>
                    {" "}· synced <RelativeTime value={s.sync.at} />
                  </>
                ) : (
                  " · not synced yet"
                )}
              </>
            ),
          };
  const showKeyInput = !s.key_set || replacing || urlChanged;

  return (
    <PageContainer>
      {header}
      <div className="flex flex-col gap-4">
        {part === "snipeit" && (
          <section aria-labelledby="assets-snipeit" className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs" data-testid="assets-snipeit">
            <div className="flex flex-wrap items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
                <Package className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 id="assets-snipeit" className="text-sm font-semibold text-slate-900">
                  Snipe-IT
                </h2>
                <p className="text-sm text-slate-500" data-testid="assets-sync-line">
                  {state.line}
                </p>
              </div>
              <span className={chipClass(state.tone)}>{state.chip}</span>
              {connected && (
                <Button variant="ghost" size="sm" className="ml-auto" busy={busy === "disconnect"} onClick={disconnect}>
                  Disconnect
                </Button>
              )}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Address">
                <TextInput value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://assets.example.com" inputMode="url" autoComplete="off" spellCheck={false} />
              </Field>
              {showKeyInput ? (
                <Field label="API key">
                  <TextInput
                    ref={keyInput}
                    type="password"
                    value={f.api_key}
                    onChange={(e) => set({ api_key: e.target.value })}
                    placeholder={s.key_set && !urlChanged ? "Paste the new key" : "Paste the key from Snipe-IT"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              ) : (
                // A saved key: not a control, so not inside Field's <label> (a button there takes the label's name).
                <div role="group" aria-labelledby="assets-key-label">
                  <span id="assets-key-label" className="mb-1 block text-xs font-medium text-slate-500">
                    API key
                  </span>
                  <div className={controlClass(false, "flex items-center gap-2")}>
                    <span aria-hidden>••••••••••••••••</span>
                    <span className="sr-only">Saved</span>
                    <Lock className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                    <button
                      type="button"
                      className="link ml-auto text-sm"
                      aria-label="Replace the API key"
                      onClick={() => {
                        setReplacing(true);
                        requestAnimationFrame(() => keyInput.current?.focus());
                      }}
                    >
                      Replace
                    </button>
                  </div>
                </div>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-500">
              A read key is enough to look up assets. To log maintenance, the key needs permission to create maintenances. The key is stored encrypted and never shown again.
              {urlChanged && s.key_set ? " A new address needs the key again, and starts a new asset list: assets linked from the old one stay on their tickets, marked as no longer in Snipe-IT." : ""}
            </p>

            <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-900">When a ticket with a linked asset is solved</h3>
            <RadioCards
              label="When a ticket with a linked asset is solved"
              name="hd-assets-on-solve"
              value={f.on_solve}
              onChange={(v) => set({ on_solve: v })}
              options={[
                { value: "nothing", label: "Do nothing in Snipe-IT", description: "" },
                {
                  value: "offer_maintenance",
                  label: "Offer to log a maintenance record",
                  description: "The agent chooses the type (Repair, Upgrade, Software support…) and can edit the note before it goes. The ticket number is added.",
                },
              ]}
            />

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon={<PlugZap />} busy={busy === "test"} onClick={test} disabled={!f.url.trim()}>
                Test connection
              </Button>
              <Button variant="secondary" icon={<RefreshCw />} busy={busy === "sync" || s.sync.running} onClick={sync} disabled={!connected}>
                Sync now
              </Button>
            </div>
          </section>
        )}

        {part === "intune" && <IntuneCard view={view} snipeConnected={connected} onView={(v) => apply(v, false)} />}

        {part === "access" && (
          <Card title="Who sees assets">
            <p className="text-sm text-slate-600">
              Agents see the assets of the people whose tickets they can work. Requesters see their own devices when they raise a request, so they can pick the one with the problem.
            </p>
            <Toggle
              className="mt-4"
              label="Agents can search all assets"
              help="By tag, serial or name, to link any device to a ticket. Off: only the assets of people whose tickets they can work."
              checked={f.agents_search_all}
              onChange={(v) => set({ agents_search_all: v })}
            />
          </Card>
        )}
      </div>
      {part !== "intune" && <SaveRow dirty={dirty} busy={busy === "save"} onSave={save} label={part === "snipeit" ? "Save Snipe-IT settings" : "Save asset settings"} />}
    </PageContainer>
  );
}

// --- Microsoft Intune (1.19.4; its own app registration 1.20.2) -----------------------------

const PERMISSION_URL = "https://learn.microsoft.com/graph/permissions-reference#devicemanagementmanageddevicesreadall";

function IntuneCard({ view, snipeConnected, onView }: { view: HdAssetSettingsView; snipeConnected: boolean; onView: (v: HdAssetSettingsView) => void }) {
  const it = view.intune;
  const [busy, setBusy] = useState<"" | "connect" | "test" | "sync" | "off" | "forget">("");
  const [problem, setProblem] = useState("");
  const [tenant, setTenant] = useState(it.tenant);
  const [clientId, setClientId] = useState(it.client_id);
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const legacy = it.mode === "directory";
  const own = it.secret_set;
  // A saved secret only stands for the app registration it was saved for.
  const sameApp = own && tenant.trim().toLowerCase() === it.tenant.toLowerCase() && clientId.trim().toLowerCase() === it.client_id.toLowerCase();
  const showSecretInput = !own || replacing || !sameApp;
  const typed = tenant.trim() !== it.tenant || clientId.trim() !== it.client_id || secret.trim() !== "";
  const devices = `${it.sync.count.toLocaleString()} ${it.sync.count === 1 ? "device" : "devices"}`;
  const error = problem || it.check_error || (it.on && it.sync.ok === false ? it.sync.error : "");
  const credentials = () => ({ tenant: tenant.trim(), client_id: clientId.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) });

  const state = it.sync.running
    ? { tone: "info" as const, chip: "Syncing", line: `Syncing now · ${devices} so far` }
    : it.unavailable === "legacy_gone"
      ? { tone: "warn" as const, chip: "Needs attention", line: "The directory sync app it was using is no longer set up. Enter Intune's own app registration below." }
      : !it.on
        ? { tone: "neutral" as const, chip: "Not connected", line: own ? "Switched off. Connect to sync its devices again." : "Enter the app registration Intune signs in with to start." }
        : error
          ? { tone: "warn" as const, chip: "Needs attention", line: `Connected · ${devices}` }
          : { tone: "ok" as const, chip: "Connected", line: [`Connected · ${it.sync.at ? devices : "not synced yet"}`, snipeConnected ? "matched to Snipe-IT by serial" : ""].filter(Boolean).join(" · ") };

  async function connect(confirmTenant = false) {
    setBusy("connect");
    setProblem("");
    try {
      const v = await sendJson<HdAssetSettingsView>(URL_, "PUT", { intune_credentials: credentials(), ...(confirmTenant ? { confirm_tenant_change: true } : {}) }, "Couldn't connect Intune.");
      onView(v);
      setSecret("");
      setReplacing(false);
      toast("ok", legacy ? "Intune now signs in with its own app registration. Its devices and their links are unchanged." : "Intune is connected. Its devices sync now and every 30 minutes.");
      // The first sync: started here, carried on by the server (the page polls while it runs).
      sendJson<{ settings: HdAssetSettingsView }>(`${URL_}/sync`, "POST", { provider: "intune" })
        .then((r) => onView(r.settings))
        .catch(() => {});
    } catch (e) {
      // Another tenant than the devices already here: say what that means, then go ahead only on a yes.
      if (e instanceof ApiError && e.code === "tenant_change" && !confirmTenant) {
        setBusy("");
        const ok = await confirmDialog({ title: "Connect a different Microsoft 365 tenant?", body: e.message, confirmLabel: "Connect and start a new list", danger: true });
        if (ok === true) await connect(true);
        return;
      }
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setProblem("");
    try {
      const r = await sendJson<{ ok: boolean; total?: number; error?: string }>(`${URL_}/test`, "POST", { provider: "intune", ...(typed || !it.on ? credentials() : {}) }, "Couldn't test the connection.");
      if (r.ok) toast("ok", `Signed in to Microsoft Graph: ${(r.total ?? 0).toLocaleString()} managed ${r.total === 1 ? "device" : "devices"}.`);
      else setProblem(r.error || "Couldn't connect to Intune.");
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function turnOff(forget: boolean) {
    const ok = await confirmDialog(
      forget
        ? { title: "Forget Intune's app registration?", body: "The tenant, client ID and secret are removed, syncing stops and Intune devices can't be linked to tickets. Devices already linked stay on their tickets, as they were last synced.", confirmLabel: "Forget and disconnect", danger: true }
        : { title: legacy ? "Stop using the directory sync app?" : "Turn Intune off?", body: `Syncing stops and Intune devices can't be linked to tickets. Devices already linked stay on their tickets, as they were last synced.${legacy ? " To connect again, enter Intune's own app registration here: directory sync itself is not changed." : ""}`, confirmLabel: legacy ? "Stop using it" : "Turn off", danger: true }
    );
    if (ok !== true) return;
    setBusy(forget ? "forget" : "off");
    setProblem("");
    try {
      const v = await sendJson<HdAssetSettingsView>(URL_, "PUT", forget ? { intune_credentials: null } : { intune: false }, "Couldn't turn Intune off.");
      onView(v);
      if (forget) {
        setTenant("");
        setClientId("");
        setSecret("");
      }
      toast("ok", forget ? "Intune disconnected and its app registration forgotten." : "Intune is off.");
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function sync() {
    setBusy("sync");
    setProblem("");
    try {
      const r = await sendJson<{ ok: boolean | null; seen: number; error: string | null; running: boolean; settings: HdAssetSettingsView }>(`${URL_}/sync`, "POST", { provider: "intune" }, "Couldn't sync.");
      onView(r.settings);
      if (r.running) toast("ok", "Syncing. This page updates when it's done.");
      else if (r.ok) toast("ok", `Synced ${r.seen.toLocaleString()} ${r.seen === 1 ? "device" : "devices"} from Intune.`);
      else toast("error", r.error || "The sync failed.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  // Graph's 403 names the permission; say where it goes.
  const permission = error.includes(INTUNE_PERMISSION);
  return (
    <>
      <section aria-labelledby="assets-intune" className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs" data-testid="assets-intune">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
            <Laptop className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="assets-intune" className="text-sm font-semibold text-slate-900">
              Connection
            </h2>
            <p className="text-sm text-slate-500" data-testid="assets-intune-line">
              {state.line}
            </p>
          </div>
          <span className={chipClass(state.tone)}>{state.chip}</span>
        </div>

        {legacy && (
          <div className="mt-4 rounded-lg border border-compass-200 bg-compass-50 px-3 py-2 text-sm text-compass-800 dark:border-compass-500/40" data-testid="assets-intune-legacy">
            <p className="font-medium">Using the directory sync app</p>
            <p className="mt-0.5">
              Intune signs in as your Microsoft 365 directory sync&apos;s app registration, as it has since it was connected. Nothing changes until you enter an app registration of Intune&apos;s own below: the
              devices and their links stay, and the directory sync app then no longer needs the {INTUNE_PERMISSION} permission.
            </p>
          </div>
        )}
        {it.mode === "own" && it.on && (
          <p className="mt-3 text-xs text-slate-500" data-testid="assets-intune-own">
            Signs in with its own app registration. The Microsoft 365 directory sync is not used: its app does not need the {INTUNE_PERMISSION} permission, and Intune works whether or not directory sync is set up.
          </p>
        )}

        <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-900">{legacy ? "Use Intune's own app registration" : "App registration"}</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Tenant" help="The tenant ID, or a domain such as contoso.onmicrosoft.com.">
            <TextInput value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="contoso.onmicrosoft.com" autoComplete="off" spellCheck={false} autoCapitalize="none" />
          </Field>
          <Field label="Application (client) ID" help="From the app registration's Overview page in Entra.">
            <TextInput value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" spellCheck={false} autoCapitalize="none" className="font-mono" />
          </Field>
          {showSecretInput ? (
            <Field label="Client secret" help="The secret's Value, not its ID. Stored encrypted and never shown again.">
              <TextInput ref={secretInput} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={own && sameApp ? "Paste the new secret" : "Paste the secret from Entra"} autoComplete="off" spellCheck={false} />
            </Field>
          ) : (
            // A saved secret: not a control, so not inside Field's <label> (a button there takes the label's name).
            <div role="group" aria-labelledby="intune-secret-label">
              <span id="intune-secret-label" className="mb-1 block text-xs font-medium text-slate-500">
                Client secret
              </span>
              <div className={controlClass(false, "flex items-center gap-2")}>
                <span aria-hidden>••••••••••••••••</span>
                <span className="sr-only">Saved</span>
                <Lock className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                <button
                  type="button"
                  className="link ml-auto text-sm"
                  aria-label="Replace the client secret"
                  onClick={() => {
                    setReplacing(true);
                    requestAnimationFrame(() => secretInput.current?.focus());
                  }}
                >
                  Replace
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="mt-2 text-sm text-slate-500">
          In Entra, register an app for Intune, give it only the <span className="font-medium text-slate-700">{INTUNE_PERMISSION}</span> application permission and grant admin consent.{" "}
          <a className="link" href={PERMISSION_URL} target="_blank" rel="noopener noreferrer">
            About this permission
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>

        {error && (
          <div className="mt-3" data-testid="assets-intune-error">
            <FormError>{error}</FormError>
            {permission && (
              <p className="mt-1 text-xs text-slate-500">The permission goes on {legacy && !typed ? "the directory sync app" : "the Intune app registration"} in Entra, under API permissions, as an application permission.</p>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button icon={<PlugZap />} busy={busy === "connect"} disabled={busy !== "" || !tenant.trim() || !clientId.trim() || (showSecretInput && !secret.trim()) || (it.on && own && !typed)} onClick={() => void connect()}>
            {it.on && own ? "Save and reconnect" : legacy ? "Switch to this app" : "Connect"}
          </Button>
          <Button variant="secondary" busy={busy === "test"} disabled={busy !== "" || (!it.on && (!tenant.trim() || !clientId.trim() || (showSecretInput && !secret.trim())))} onClick={test}>
            Test connection
          </Button>
          {it.on && (
            <Button variant="secondary" icon={<RefreshCw />} busy={busy === "sync" || it.sync.running} disabled={busy !== "" && busy !== "sync"} onClick={sync}>
              Sync now
            </Button>
          )}
          {it.on && (
            <Button variant="ghost" size="sm" className="ml-auto" busy={busy === "off"} onClick={() => void turnOff(false)}>
              {legacy ? "Stop using the directory sync app" : "Turn off"}
            </Button>
          )}
          {own && (
            <Button variant="ghost" size="sm" className={it.on ? "" : "ml-auto"} busy={busy === "forget"} onClick={() => void turnOff(true)}>
              Forget credentials
            </Button>
          )}
        </div>
        {it.on && (
          <p className="mt-3 text-xs text-slate-500">
            {it.sync.at ? (
              <>
                Synced <RelativeTime value={it.sync.at} />
                {it.matched ? ` · ${it.matched.toLocaleString()} shown as their Snipe-IT asset` : ""}
              </>
            ) : (
              "Not synced yet"
            )}
          </p>
        )}
      </section>
      <Card title="Matching devices to people">
        <p className="text-sm text-slate-600">
          A device belongs to the person whose CompassDocs account has the same address as the device&apos;s user in Intune (the email address or the sign-in name). Only an address set by an admin, single
          sign-on or provisioning counts: one a person typed into their own profile never shows them someone else&apos;s devices. No directory sync is needed for this.
        </p>
      </Card>
    </>
  );
}

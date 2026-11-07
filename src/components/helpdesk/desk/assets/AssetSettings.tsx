"use client";

// Desk settings → Assets (1.19.3; mock-up i3): where devices come from, so
// agents can link them to tickets and see each one's history. One source in
// 1.19.3, Snipe-IT: its address (https only) and API key (stored encrypted,
// never shown again: the field only says one is saved and offers Replace),
// what solving does (nothing / offer a maintenance record), Test connection
// (the typed values, or the saved ones) and Sync now (a full sync; the page
// polls while it runs). The "Who sees assets" card holds "Agents can search
// all assets". One Save for the page. GET/PUT /api/helpdesk/admin/assets,
// POST …/test and …/sync (settings.manage).
//
// 1.19.4: the Microsoft Intune card (IntuneCard; mock-up i3). Intune signs in
// with the Microsoft 365 directory sync's app registration, so the card has
// no fields: one switch that applies straight away (turning it on tests
// Graph first and says why it can't, e.g. the missing permission), the
// device count and "matched to Snipe-IT by serial", and Sync now.

import { useCallback, useEffect, useRef, useState } from "react";
import { Laptop, Lock, Package, PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { Field, TextInput, Toggle, controlClass } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RadioCards } from "@/components/PolicyFields";
import { RelativeTime } from "@/components/RelativeTime";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { INTUNE_PERMISSION, type HdAssetOnSolve, type HdAssetSettingsView } from "@/lib/helpdesk/assets-shared";
import { getJson, sendJson } from "../api";

const URL_ = "/api/helpdesk/admin/assets";

interface Form {
  url: string;
  api_key: string;
  on_solve: HdAssetOnSolve;
  agents_search_all: boolean;
}

const formOf = (v: HdAssetSettingsView): Form => ({ url: v.snipeit.url, api_key: "", on_solve: v.snipeit.on_solve, agents_search_all: v.agents_search_all });

export function AssetSettings() {
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

  if (error && !view) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!view || !f) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

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
      <PageHeader icon={<Package />} title="Assets" subtitle="Where devices come from, so agents can link them to tickets and see each one's history." />
      <div className="flex flex-col gap-4">
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

        <IntuneCard view={view} snipeConnected={connected} onView={(v) => apply(v, false)} />

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
      </div>
      <SaveRow dirty={dirty} busy={busy === "save"} onSave={save} label="Save asset settings" />
    </PageContainer>
  );
}

// --- Microsoft Intune (1.19.4) ------------------------------------------------------------

function IntuneCard({ view, snipeConnected, onView }: { view: HdAssetSettingsView; snipeConnected: boolean; onView: (v: HdAssetSettingsView) => void }) {
  const it = view.intune;
  const [busy, setBusy] = useState<"" | "toggle" | "sync">("");
  const [problem, setProblem] = useState("");
  const devices = `${it.sync.count.toLocaleString()} ${it.sync.count === 1 ? "device" : "devices"}`;
  const parts = ["Uses your Microsoft 365 directory sync"];
  if (it.on) parts.push(it.sync.running ? `syncing now, ${devices} so far` : it.sync.at ? devices : "not synced yet");
  if (snipeConnected) parts.push("matched to Snipe-IT by serial");
  const line =
    it.unavailable === "licence"
      ? "Uses your Microsoft 365 directory sync, which needs an enterprise licence."
      : it.unavailable === "credentials"
        ? "Uses your Microsoft 365 directory sync. Set that up first, then switch Intune on here."
        : parts.join(" · ");
  const error = problem || it.check_error || (it.on && it.sync.ok === false ? it.sync.error : "");

  async function toggle(next: boolean) {
    if (!next) {
      const ok = await confirmDialog({
        title: "Turn Intune off?",
        body: "Syncing stops and Intune devices can't be linked to tickets. Devices already linked stay on their tickets, as they were last synced.",
        confirmLabel: "Turn off",
        danger: true,
      });
      if (ok !== true) return;
    }
    setBusy("toggle");
    setProblem("");
    try {
      const v = await sendJson<HdAssetSettingsView>(URL_, "PUT", { intune: next }, next ? "Couldn't turn Intune on." : "Couldn't turn Intune off.");
      onView(v);
      if (next) {
        toast("ok", "Intune is on. Its devices sync now and every 30 minutes.");
        // The first sync: started here, carried on by the server (the page polls while it runs).
        sendJson<{ settings: HdAssetSettingsView }>(`${URL_}/sync`, "POST", { provider: "intune" })
          .then((r) => onView(r.settings))
          .catch(() => {});
      } else toast("ok", "Intune is off.");
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
      const r = await sendJson<{ ok: boolean | null; seen: number; error: string | null; running: boolean; settings: HdAssetSettingsView }>(
        `${URL_}/sync`,
        "POST",
        { provider: "intune" },
        "Couldn't sync."
      );
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
    <section aria-labelledby="assets-intune" className="rounded-xl border border-slate-200 bg-surface p-5 shadow-xs" data-testid="assets-intune">
      <h2 id="assets-intune" className="sr-only">
        Microsoft Intune
      </h2>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
          <Laptop className="h-5 w-5" />
        </span>
        <Toggle
          size="full"
          className="min-w-0 flex-1"
          label={<span className="font-semibold text-slate-900">Microsoft Intune</span>}
          help={<span className="text-sm" data-testid="assets-intune-line">{line}</span>}
          checked={it.on}
          disabled={busy === "toggle" || (!it.on && it.unavailable !== null)}
          onChange={toggle}
        />
      </div>
      {it.unavailable === "credentials" && (
        <p className="mt-2 pl-12 text-sm">
          <a className="link" href="/admin/directory/sync">
            Set up Microsoft 365 directory sync
          </a>
        </p>
      )}
      {error && (
        <div role="alert" className="notice-warn mt-3 rounded-lg border px-3 py-2 text-sm sm:ml-12" data-testid="assets-intune-error">
          {error}
          {permission && (
            <>
              {" "}
              <a className="link" href="https://learn.microsoft.com/graph/permissions-reference#devicemanagementmanageddevicesreadall" target="_blank" rel="noopener noreferrer">
                About this permission
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </div>
      )}
      {it.on && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 sm:pl-12">
          {it.sync.at ? (
            <span>
              Synced <RelativeTime value={it.sync.at} />
              {it.matched ? ` · ${it.matched.toLocaleString()} shown as their Snipe-IT asset` : ""}
            </span>
          ) : (
            <span>Not synced yet</span>
          )}
          <Button variant="ghost" size="sm" icon={<RefreshCw />} busy={busy === "sync" || it.sync.running} onClick={sync}>
            Sync now
          </Button>
        </div>
      )}
    </section>
  );
}

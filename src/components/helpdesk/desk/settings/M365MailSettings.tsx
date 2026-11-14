"use client";

// Settings → Email, the Microsoft 365 card (1.20.7, lib/helpdesk/m365): the
// desk reads the help mailboxes straight from Microsoft 365 through
// Microsoft Graph, so nothing is forwarded to the webhook.
//
//   not set up   "Set up automatically with Microsoft" (MsDeviceSetup, the
//                enterprise build's one-click flow) above a closed
//                <details> with the three fields, as the way to do it by
//                hand; a line says what is and is not supported.
//   set up       the mailboxes (a list that acts at once: Connect mailbox,
//                Check now, Try again, Disconnect), each with how its mail
//                arrives, when it was last read, its counts and its last
//                error in words, and a closed "Last messages" (how the
//                sender check went for the last few, never any content);
//                then three <details>: "Limit the app to your help
//                mailboxes" (the Exchange Online commands with Copy, and
//                Check access with its answer), "Options" and "App
//                registration".
//
// Who may do what: saving or removing the connection and connecting or
// disconnecting a mailbox decide what the desk reads, so they need
// settings.manage (the API refuses the rest); without it those controls are
// not shown and a line says who to ask. Everything else is the page's own
// channels.manage.
//
// The help address dialog on the same page reads the same data
// (useM365Mail): M365MailboxField is its "Microsoft 365 mailbox" pick, and
// the address rows show M365AddressChip and M365AddressWarning.

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Plus, RefreshCw, RotateCcw, ShieldCheck, Unplug } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { confirmDialog } from "@/components/Dialog";
import { Field, FormError, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { MsDeviceSetup } from "@/components/MsDeviceSetup";
import { RadioCards } from "@/components/PolicyFields";
import { RelativeTime } from "@/components/RelativeTime";
import { useFormatDate } from "@/components/SettingsProvider";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import {
  M365_GRAPH_ID_PROBLEM,
  M365_MAIL_LIMITS,
  M365_ROLES,
  cleanM365GraphId,
  m365AddressProblem,
  m365CredentialsProblem,
  modeSentence,
  restrictCommands,
  type M365AccessCheck,
  type M365AfterIntake,
  type M365MailView,
  type M365MailboxView,
  type M365MessageDiag,
} from "@/lib/helpdesk/m365-mail-shared";
import { ApiError, getJson, sendJson } from "../api";
import { useCan } from "../me";

const URL_ = "/api/helpdesk/admin/m365-mail";
const SUMMARY = "cursor-pointer text-sm font-semibold text-slate-900";
// Long commands wrap rather than scroll: the whole of each one is in view, and Copy takes them as they are.
const PRE = "whitespace-pre-wrap rounded-lg border border-slate-200 bg-canvas p-3 font-mono text-xs leading-5 text-slate-700 [overflow-wrap:anywhere]";

// --- One copy of the view for the card, the address rows and the dialog --------------

let view: M365MailView | null = null;
let loadError = "";
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setM365Mail(v: M365MailView): void {
  view = v;
  loadError = "";
  emit();
}

export function loadM365Mail(): Promise<void> {
  loading ??= getJson<M365MailView>(URL_, "Couldn't load the Microsoft 365 connection.")
    .then(setM365Mail)
    .catch((e: Error) => {
      loadError = e.message;
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The Microsoft 365 connection as the page last read it (null until it has). */
export function useM365Mail(): M365MailView | null {
  const v = useSyncExternalStore(subscribe, () => view, () => null);
  useEffect(() => {
    if (!view) void loadM365Mail();
  }, []);
  return v;
}

/** Say which connected mailbox a help address lives on (null = none) and whether its replies go out through Microsoft 365. */
export async function saveM365AddressLink(helpAddressId: number, m365MailboxId: number | null, sendVia: boolean): Promise<void> {
  const r = await sendJson<{ view: M365MailView }>(`${URL_}/addresses/${helpAddressId}`, "PUT", { m365_mailbox_id: m365MailboxId, send_via: sendVia }, "Couldn't save the Microsoft 365 choice.");
  setM365Mail(r.view);
}

// --- Pieces of the help address list and dialog ----------------------------------------

/** On an address row: the chip that says the address is read from Microsoft 365. */
export function M365AddressChip({ id }: { id: number }) {
  const v = useM365Mail();
  const link = v?.connected ? v.links.find((l) => l.mailbox_id === id) : undefined;
  if (!link) return null;
  return (
    <Chip tone="info" size="sm" data-testid="hd-mailbox-m365">
      Microsoft 365
    </Chip>
  );
}

/** On an address row: where its replies leave from, and Microsoft's refusal when a reply was turned down. */
export function M365AddressWarning({ id, workspaceFrom }: { id: number; workspaceFrom: string }) {
  const v = useM365Mail();
  const fmt = useFormatDate();
  const link = v?.connected ? v.links.find((l) => l.mailbox_id === id) : undefined;
  if (!link?.send_via) return null;
  return (
    <>
      <p className="mt-0.5 text-xs text-slate-500 [overflow-wrap:anywhere]" data-testid="hd-mailbox-m365-send">
        Sends through Microsoft 365 as {link.m365_address}
      </p>
      {link.send_error && (
        <p className="ink-warn mt-1 text-xs [overflow-wrap:anywhere]" data-testid="hd-mailbox-m365-warning">
          Microsoft 365 refused a reply{link.send_error_at ? ` on ${fmt.dateTime(link.send_error_at)}` : ""}: {link.send_error} Replies go out from {workspaceFrom} under this name until one goes through.
        </p>
      )}
    </>
  );
}

/**
 * In the help address dialog: "Microsoft 365 mailbox". `value` is the
 * connected mailbox's id as text ("" = not on Microsoft 365). Renders
 * nothing while no mailbox is connected, so the dialog is as it was.
 */
export function M365MailboxField({ value, onChange, typed }: { value: string; onChange: (next: string) => void; typed: string | null }) {
  const v = useM365Mail();
  if (!v?.connected || v.mailboxes.length === 0) return null;
  const picked = v.mailboxes.find((m) => String(m.id) === value);
  // An alias of the picked mailbox: Microsoft only keeps the alias on a message when the organisation says so.
  const alias = !!picked && !!typed && typed !== picked.address;
  return (
    <Field
      label="Microsoft 365 mailbox"
      help={
        alias
          ? `The desk reads this address's mail in ${picked.address}. Microsoft 365 shows mail sent to an alias under the mailbox's main address unless your organisation has turned on sending from aliases (SendFromAliasEnabled). Until it has, mail to this alias is handled as mail to ${picked.address}.`
          : "Pick the connected mailbox this address belongs to, and the desk reads its mail there. An alias uses the mailbox it is an alias of. Distribution lists and Microsoft 365 groups can't be read: use a shared mailbox."
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid="hd-mailbox-m365-pick">
        <option value="">Not on Microsoft 365 (forwarded to the webhook)</option>
        {v.mailboxes.map((m) => (
          <option key={m.id} value={m.id}>
            {typed && typed !== m.address ? `${m.address} (this address is an alias of it)` : m.address}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The address of a connected mailbox by its id as text ('' when none). */
export function m365MailboxAddress(v: M365MailView | null, id: string): string {
  return v?.mailboxes.find((m) => String(m.id) === id)?.address ?? "";
}

// --- The card --------------------------------------------------------------------------

export function M365MailCard() {
  const v = useM365Mail();
  const [setupDone, setSetupDone] = useState(false);
  const error = useSyncExternalStore(subscribe, () => loadError, () => "");
  // Which app the desk signs in as and which mailboxes it reads: settings.manage. The rest of the card: the page's own capability.
  const manage = useCan()("settings.manage");

  // The statuses move by themselves (a read every few minutes): read them again while the card is open.
  const live = !!v?.connected;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void loadM365Mail(), 30_000);
    return () => clearInterval(t);
  }, [live]);

  return (
    <Card
      id="microsoft-365"
      className="scroll-mt-6"
      title="Microsoft 365"
      description="Read your help mailboxes straight from Microsoft 365. Nothing has to be forwarded."
      actions={v?.connected ? <StatusChip v={v} /> : undefined}
    >
      <div data-testid="hd-m365">
        {!v ? (
          error ? (
            <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
          ) : (
            <LoadingRow className="py-4" />
          )
        ) : (
          <>
            {manage && (!v.connected || setupDone) && (
              <MsDeviceSetup
                startUrl="/api/ee/m365-mail/setup/start"
                pollUrl="/api/ee/m365-mail/setup/poll"
                refreshUrl={URL_}
                blurb="Signs you in once as a tenant admin and creates an app registration for the desk. The app can't read any mailbox until you allow it, in the next step."
                doneMessage={(r) =>
                  r?.verified === false
                    ? "The app registration was created in Entra and saved here. Microsoft is still activating it. Connect your mailboxes below, then press Check access in a minute."
                    : `Done. The app registration was created in Entra and saved here. It can't read any mailbox yet: connect your help mailboxes below, then run the commands under Limit access.${r?.secret_expires ? ` The client secret is good until ${r.secret_expires}.` : ""}`
                }
                doneWarn={(r) => r?.verified === false}
                onDone={(fresh: M365MailView) => {
                  setSetupDone(true);
                  setM365Mail(fresh);
                }}
              />
            )}
            {v.connected ? <Connected v={v} manage={manage} /> : <NotConnected v={v} manage={manage} />}
          </>
        )}
      </div>
    </Card>
  );
}

function attention(v: M365MailView): boolean {
  return !v.verified || v.tenant_wide.length > 0 || v.mailboxes.some((m) => m.last_error || m.sub_error) || v.links.some((l) => l.send_error);
}

function StatusChip({ v }: { v: M365MailView }) {
  return attention(v) ? (
    <Chip tone="warn" size="sm">
      Needs attention
    </Chip>
  ) : (
    <Chip tone="ok" size="sm">
      Connected
    </Chip>
  );
}

const SUPPORTED = "Works with shared mailboxes and user mailboxes. Distribution lists and Microsoft 365 groups are not supported: use a shared mailbox instead.";

const ASK = "Connecting Microsoft 365 and choosing which mailboxes it reads takes the Helpdesk settings capability. Ask someone whose desk role has it.";

function NotConnected({ v, manage }: { v: M365MailView; manage: boolean }) {
  if (!manage) {
    return (
      <>
        <p className="text-sm text-slate-600" data-testid="hd-m365-ask">
          Microsoft 365 is not connected. {ASK}
        </p>
        {v.orphaned && <MailboxList v={v} manage={false} />}
      </>
    );
  }
  return (
    <>
      {v.orphaned && (
        <p className="notice-warn mb-3 rounded-lg border px-3 py-2 text-sm">
          The connection was removed, so the mailboxes below are not being read. Connect the same Microsoft 365 organisation again, or disconnect them.
        </p>
      )}
      <details className="text-sm text-slate-600" data-testid="hd-m365-manual">
        <summary className={SUMMARY}>Enter an app registration by hand</summary>
        <p className="mt-2 text-xs text-slate-500">
          Register an app in Entra (single tenant), add a client secret, and give it no Microsoft Graph mail permissions: you limit it to your help mailboxes in the next step.
        </p>
        <CredentialsForm className="mt-3" submit="Connect" />
      </details>
      <p className="mt-3 text-xs text-slate-500">{SUPPORTED}</p>
      {v.orphaned && <MailboxList v={v} manage={manage} />}
    </>
  );
}

function CredentialsForm({ className = "", submit, tenant = "", clientId = "", keepSecret = false, onSaved }: { className?: string; submit: string; tenant?: string; clientId?: string; keepSecret?: boolean; onSaved?: () => void }) {
  const [t, setT] = useState(tenant);
  const [c, setC] = useState(clientId);
  const [s, setS] = useState("");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const same = keepSecret && t.trim().toLowerCase() === tenant && c.trim().toLowerCase() === clientId;
  const problem = tried ? m365CredentialsProblem({ tenant: t, client_id: c, secret: s }, same) : "";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    if (m365CredentialsProblem({ tenant: t, client_id: c, secret: s }, same)) return;
    setBusy(true);
    try {
      const r = await sendJson<{ view: M365MailView }>(URL_, "PUT", { tenant: t.trim(), client_id: c.trim(), secret: s.trim() }, "Couldn't save the app registration.");
      setM365Mail(r.view);
      setS("");
      setTried(false);
      toast("ok", "Microsoft 365 is connected. Connect your help mailboxes next.");
      onSaved?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className={className}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Tenant ID" help="The directory (tenant) ID, or a domain such as contoso.onmicrosoft.com.">
          <TextInput value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} />
        </Field>
        <Field label="Application (client) ID" help="From the app registration's Overview page.">
          <TextInput value={c} onChange={(e) => setC(e.target.value)} autoComplete="off" spellCheck={false} maxLength={64} />
        </Field>
        <Field label="Client secret" help={same ? "Leave empty to keep the saved secret." : "The secret's Value, not its ID. It is stored encrypted and never shown again."}>
          <TextInput type="password" value={s} onChange={(e) => setS(e.target.value)} autoComplete="new-password" maxLength={400} />
        </Field>
      </div>
      <FormError className="mt-3">{problem || error}</FormError>
      <div className="mt-4">
        <Button type="submit" variant="secondary" size="sm" busy={busy}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

function Connected({ v, manage }: { v: M365MailView; manage: boolean }) {
  // What the app's own token carries, read when the connection was saved and every half hour since (and by Check access).
  const wide = v.tenant_wide;
  const checkedOk = !!v.access && wide.length === 0 && v.access.mailboxes.length > 0 && v.access.mailboxes.every((m) => m.ok);
  // Open until a check came back clean; after that it is the admin's to open and close (a check never shuts it on its own answer).
  const [restrictOpen, setRestrictOpen] = useState(!checkedOk);
  return (
    <>
      {!v.verified && (
        <p className="notice-warn mb-3 rounded-lg border px-3 py-2 text-sm" data-testid="hd-m365-activating">
          Microsoft is still activating the new app registration. Press Check access in a minute.
        </p>
      )}
      {wide.length > 0 && (
        <p className="notice-warn mb-3 rounded-lg border px-3 py-2 text-sm" data-testid="hd-m365-tenant-wide">
          This app can read every mailbox in your organisation. It holds {wide.join(", ")} granted in Entra. Run the commands under Limit access, then remove {wide.length === 1 ? "that permission" : "those permissions"} from the app in Entra (App registrations, API permissions). The desk looks again every half hour, and when you press Check access.
        </p>
      )}
      <MailboxList v={v} manage={manage} />
      <details className="mt-5 text-sm text-slate-600" open={restrictOpen} onToggle={(e) => setRestrictOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="hd-m365-restrict">
        <summary className={SUMMARY}>
          Limit the app to your help mailboxes
          <span className={`ml-2 text-xs font-normal ${wide.length ? "ink-warn" : "text-slate-500"}`} data-testid="hd-m365-restrict-state">
            {wide.length ? "It reaches every mailbox" : checkedOk ? "Checked: no organisation-wide access" : "Not confirmed yet"}
          </span>
        </summary>
        <Restrict v={v} />
      </details>
      <details className="mt-4 text-sm text-slate-600" data-testid="hd-m365-options">
        <summary className={SUMMARY}>Options</summary>
        <Options v={v} />
      </details>
      <details className="mt-4 text-sm text-slate-600" data-testid="hd-m365-app">
        <summary className={SUMMARY}>App registration</summary>
        <AppRegistration v={v} manage={manage} />
      </details>
    </>
  );
}

function MailboxList({ v, manage }: { v: M365MailView; manage: boolean }) {
  const [address, setAddress] = useState("");
  const [graphId, setGraphId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<number | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const full = v.mailboxes.length >= v.limit;

  /** With organisation-wide access the list alone decides what the desk reads: say so, and ask. */
  const confirmWide = (roles: string[], a: string) =>
    confirmDialog({
      title: `Connect ${a}?`,
      body: `This app can read every mailbox in your organisation (${roles.join(", ")} ${roles.length === 1 ? "is" : "are"} granted in Entra), so Microsoft will not stop the desk from reading this one, whoever it belongs to. Connect it only if it is a help mailbox. Limiting the app first is safer.`,
      confirmLabel: "Connect anyway",
      danger: true,
    });

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const a = address.trim();
    const problem = m365AddressProblem(a) || (cleanM365GraphId(graphId) === null ? M365_GRAPH_ID_PROBLEM : "");
    if (problem) {
      setError(problem);
      return;
    }
    let confirmed = false;
    if (v.tenant_wide.length) {
      if ((await confirmWide(v.tenant_wide, a)) !== true) return;
      confirmed = true;
    }
    setBusy(true);
    try {
      const send = (confirm: boolean) =>
        sendJson<{ mailbox: { address: string; waiting: boolean; linked: string | null }; view: M365MailView }>(
          `${URL_}/mailboxes`,
          "POST",
          { address: a, ...(graphId.trim() ? { graph_id: graphId.trim() } : {}), ...(confirm ? { confirm_tenant_wide: true } : {}) },
          "Couldn't connect the mailbox."
        );
      let r;
      try {
        r = await send(confirmed);
      } catch (err) {
        // The app gained organisation-wide access since the page last looked: the same question, then once more.
        if (!(err instanceof ApiError) || err.code !== "tenant_wide" || confirmed) throw err;
        void loadM365Mail();
        if ((await confirmWide(["a Microsoft Graph mail permission"], a)) !== true) return;
        r = await send(true);
      }
      setM365Mail(r.view);
      setAddress("");
      setGraphId("");
      toast(
        "ok",
        r.mailbox.waiting
          ? `${r.mailbox.address} is listed. The app can't read it yet: run the commands under Limit access.`
          : `${r.mailbox.address} is connected.${r.mailbox.linked ? " Your help address with the same address now reads from it." : " It is not read until a help address lives on it: edit a help address and pick this mailbox."}`
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function checkNow(m: M365MailboxView) {
    setChecking(m.id);
    try {
      const r = await sendJson<{ ok: boolean; busy?: boolean; error?: string; view: M365MailView }>(`${URL_}/mailboxes/${m.id}/check`, "POST", {}, "Couldn't check the mailbox.");
      setM365Mail(r.view);
      if (r.busy) toast("ok", "A check of this mailbox is already running.");
      else if (r.ok && !r.error) toast("ok", `${m.address} was read just now.`);
      else toast("error", r.error ?? "The mailbox could not be read.");
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setChecking(null);
    }
  }

  async function tryAgain(m: M365MailboxView) {
    setRetrying(m.id);
    try {
      const r = await sendJson<{ retried: number; ok: boolean; busy?: boolean; error?: string; view: M365MailView }>(`${URL_}/mailboxes/${m.id}/retry`, "POST", {}, "Couldn't try the messages again.");
      setM365Mail(r.view);
      const left = r.view.mailboxes.find((x) => x.id === m.id)?.failed ?? 0;
      if (r.busy) toast("ok", "A check of this mailbox is already running. The messages are tried in the next one.");
      else if (!r.ok) toast("error", r.error ?? "The mailbox could not be read.");
      else if (left > 0) toast("error", `${left === 1 ? "1 message" : `${left} messages`} still could not be taken in. Last messages says why.`);
      else toast("ok", r.retried === 1 ? "The message was tried again." : `${r.retried} messages were tried again.`);
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setRetrying(null);
    }
  }

  async function disconnect(m: M365MailboxView) {
    const users = m.addresses.map((a) => a.address);
    const ok = await confirmDialog({
      title: `Disconnect ${m.address}?`,
      body: `The desk stops reading this mailbox. Nothing in it is changed or deleted.${users.length ? ` ${users.join(", ")} ${users.length === 1 ? "goes" : "go"} back to the inbound webhook.` : ""}`,
      confirmLabel: "Disconnect mailbox",
      danger: true,
    });
    if (ok !== true) return;
    try {
      const r = await sendJson<{ view: M365MailView }>(`${URL_}/mailboxes/${m.id}`, "DELETE", undefined, "Couldn't disconnect the mailbox.");
      setM365Mail(r.view);
      toast("ok", "Mailbox disconnected.");
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }

  return (
    <div className="mt-1">
      <h3 className="mb-1 text-sm font-semibold text-slate-900">Mailboxes</h3>
      {v.mailboxes.length === 0 ? (
        <SectionEmpty className="py-2">
          {manage ? "No mailbox is connected yet. Enter the main address of a shared mailbox, such as help@yourcompany.com." : "No mailbox is connected yet."}
        </SectionEmpty>
      ) : (
        <ul role="list" className="divide-y divide-slate-100 border-y border-slate-100" data-testid="hd-m365-mailboxes">
          {v.mailboxes.map((m) => (
            <MailboxRow
              key={m.id}
              v={v}
              m={m}
              manage={manage}
              checking={checking === m.id}
              retrying={retrying === m.id}
              disabled={checking !== null || retrying !== null || !v.connected}
              onCheck={() => void checkNow(m)}
              onRetry={() => void tryAgain(m)}
              onDisconnect={() => void disconnect(m)}
            />
          ))}
        </ul>
      )}
      {v.connected && !manage && (
        <p className="mt-3 text-xs text-slate-500" data-testid="hd-m365-ask">
          {ASK}
        </p>
      )}
      {v.connected && manage && (
        <form onSubmit={connect} noValidate className="mt-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Mailbox address" size="md" className="min-w-0 flex-1 basis-64">
              <TextInput type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="help@yourcompany.com" autoComplete="off" maxLength={200} disabled={full} />
            </Field>
            <Button type="submit" variant="secondary" icon={<Plus />} busy={busy} disabled={full}>
              Connect mailbox
            </Button>
          </div>
          <FormError className="mt-2">{error}</FormError>
          <p className="mt-1 text-xs text-slate-500">{full ? `Up to ${v.limit} mailboxes can be connected.` : `The mailbox's main address, not an alias. ${SUPPORTED}`}</p>
          {!full && (
            <details className="mt-2 text-sm text-slate-600" data-testid="hd-m365-connect-advanced">
              <summary className="cursor-pointer text-xs font-medium text-slate-500">Advanced</summary>
              <Field
                label="Object ID or sign-in name (optional)"
                size="md"
                className="mt-2 max-w-xl"
                help="Leave empty when the address above is also the mailbox's sign-in name. Otherwise enter the mailbox's object ID (best) or sign-in name: Microsoft looks mailboxes up by those. The commands under Limit access print both."
              >
                <TextInput value={graphId} onChange={(e) => setGraphId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" spellCheck={false} maxLength={200} data-testid="hd-m365-graph-id" />
              </Field>
            </details>
          )}
        </form>
      )}
    </div>
  );
}

const CHECK_CHIP: Record<M365MessageDiag["check"], { tone: "ok" | "warn" | "info" | "neutral"; label: string }> = {
  passed: { tone: "ok", label: "Passed" },
  failed: { tone: "warn", label: "Failed" },
  internal: { tone: "info", label: "Internal" },
  none: { tone: "neutral", label: "No result" },
  "": { tone: "neutral", label: "Not checked" },
};

const OUTCOME: Record<string, string> = {
  created: "New ticket",
  appended: "Added to a ticket",
  follow_up: "Follow-up ticket",
  alert_created: "New alert",
  alert_updated: "Alert updated",
  alert_reopened: "Alert reopened",
  alert_resolved: "Alert resolved",
  ignored_loop: "Dropped: the desk's own mail",
  ignored_auto: "Dropped: automatic mail",
  duplicate: "Dropped: already taken in",
  skipped_no_sender: "Dropped: no sender address",
  skipped_old: "Left alone: from before the mailbox was connected",
  skipped_draft: "Left alone: a draft",
  gone: "Gone from the Inbox before it was read",
  waiting: "Waiting to be tried again",
  failed: "Could not be taken in",
  working: "Being read",
};
const outcomeWords = (o: string) => OUTCOME[o] ?? (o ? `Dropped (${o.replace(/_/g, " ")})` : "Read");

/**
 * "Last messages" on a mailbox row: for the last few messages, when each
 * arrived, the sender's domain, how the sender check went and what
 * Exchange's headers said, and what became of the message. No subject, no
 * address, no content. Loaded when opened, and again on each opening.
 */
function LastMessages({ m }: { m: M365MailboxView }) {
  const fmt = useFormatDate();
  const [rows, setRows] = useState<M365MessageDiag[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      setRows((await getJson<{ messages: M365MessageDiag[] }>(`${URL_}/mailboxes/${m.id}/messages`, "Couldn't load the last messages.")).messages);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <details className="mt-2 text-sm text-slate-600" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()} data-testid="hd-m365-last-messages">
      <summary className="cursor-pointer text-xs font-medium text-slate-500">Last messages</summary>
      <p className="mt-2 text-xs text-slate-500">How the sender check went for the last messages in this mailbox, and what Microsoft's headers said. No subject, address or text is kept here.</p>
      {error ? (
        <p className="ink-warn mt-2 text-xs">{error}</p>
      ) : !rows ? (
        <LoadingRow className="py-2" />
      ) : rows.length === 0 ? (
        <SectionEmpty className="py-2">No message has been read from this mailbox yet.</SectionEmpty>
      ) : (
        <ul role="list" className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {rows.map((r, i) => (
            <li key={i} className="px-3 py-2" data-testid="hd-m365-last-message">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-700">
                <span className="text-xs text-slate-500">{fmt.dateTime(r.at)}</span>
                <span className="min-w-0 break-all font-medium text-slate-900">{r.sender_domain || "no sender"}</span>
                <Chip tone={CHECK_CHIP[r.check].tone} size="sm">
                  {CHECK_CHIP[r.check].label}
                </Chip>
                <span className="text-xs text-slate-500">{outcomeWords(r.outcome)}</span>
              </p>
              {r.reason && <p className="mt-0.5 text-xs text-slate-500 [overflow-wrap:anywhere]">{r.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** On a mailbox row, for whoever may connect mailboxes: how Microsoft Graph is asked for this one. */
function LookupField({ m }: { m: M365MailboxView }) {
  const [value, setValue] = useState(m.graph_id);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (cleanM365GraphId(value) === null) {
      setError(M365_GRAPH_ID_PROBLEM);
      return;
    }
    setBusy(true);
    try {
      const r = await sendJson<{ view: M365MailView }>(`${URL_}/mailboxes/${m.id}`, "PATCH", { graph_id: value.trim() }, "Couldn't save that.");
      setM365Mail(r.view);
      toast("ok", value.trim() ? "Saved. The desk now asks Microsoft for this mailbox by that." : "Saved. The desk asks Microsoft for this mailbox by its address again.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-2 text-sm text-slate-600" data-testid="hd-m365-lookup">
      <summary className="cursor-pointer text-xs font-medium text-slate-500">Advanced</summary>
      <form onSubmit={save} noValidate className="mt-2">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Object ID or sign-in name (optional)" size="md" className="min-w-0 flex-1 basis-64">
            <TextInput value={value} onChange={(e) => setValue(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" spellCheck={false} maxLength={200} />
          </Field>
          <Button type="submit" variant="secondary" busy={busy} disabled={value.trim().toLowerCase() === m.graph_id}>
            Save
          </Button>
        </div>
        <FormError className="mt-2">{error}</FormError>
        <p className="mt-1 text-xs text-slate-500">
          Microsoft looks a mailbox up by its object ID or sign-in name. Empty: the desk asks by the address, which works when that is also the sign-in name. The commands under Limit access print both.
        </p>
      </form>
    </details>
  );
}

function MailboxRow({
  v,
  m,
  manage,
  checking,
  retrying,
  disabled,
  onCheck,
  onRetry,
  onDisconnect,
}: {
  v: M365MailView;
  m: M365MailboxView;
  manage: boolean;
  checking: boolean;
  retrying: boolean;
  disabled: boolean;
  onCheck: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
}) {
  const fmt = useFormatDate();
  const idle = m.mode === "idle";
  const waiting = !m.last_ok_at && !!m.last_error;
  const lives = m.addresses.map((a) => a.address);
  return (
    <li className="py-3" data-testid="hd-m365-mailbox-row">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-all text-sm font-medium text-slate-900">{m.address}</span>
            {!v.connected ? (
              <Chip tone="neutral" size="sm">Not being read</Chip>
            ) : waiting ? (
              <Chip tone="warn" size="sm">Waiting for access</Chip>
            ) : idle ? (
              <Chip tone="neutral" size="sm">Not being read</Chip>
            ) : m.last_error ? (
              <Chip tone="warn" size="sm">Needs attention</Chip>
            ) : m.mode === "notifications" ? (
              <Chip tone="ok" size="sm">Notifications on</Chip>
            ) : (
              <Chip tone="neutral" size="sm">On a timer</Chip>
            )}
          </p>
          {idle ? (
            <p className="mt-0.5 text-xs text-slate-500" data-testid="hd-m365-mailbox-idle">
              {modeSentence(m.mode, v.poll_minutes, v.notify_origin)} Edit a help address above and pick this mailbox.
            </p>
          ) : (
            <>
              <p className="mt-0.5 text-xs text-slate-500 [overflow-wrap:anywhere]">
                Help {lives.length === 1 ? "address" : "addresses"}: {lives.join(", ")}
                {" · "}
                {m.last_ok_at ? (
                  <>
                    Last read <RelativeTime value={m.last_ok_at} />
                  </>
                ) : (
                  "Not read yet"
                )}
                {" · "}
                {m.taken_in} taken in, {m.dropped} dropped
                {m.waiting > 0 ? `, ${m.waiting} waiting to be tried again` : ""}
                {m.failed > 0 ? `, ${m.failed} could not be taken in` : ""}
              </p>
              {v.connected && <p className="mt-0.5 text-xs text-slate-500">{modeSentence(m.mode, v.poll_minutes, v.notify_origin)}</p>}
            </>
          )}
          {m.graph_id && <p className="mt-0.5 text-xs text-slate-500 [overflow-wrap:anywhere]">Microsoft is asked for it by {m.graph_id}</p>}
          {v.connected && !idle && m.sub_error && (
            <p className="ink-warn mt-1 text-xs [overflow-wrap:anywhere]" data-testid="hd-m365-mailbox-sub-warning">
              Notifications{m.sub_error_at ? ` (${fmt.dateTime(m.sub_error_at)})` : ""}: {m.sub_error}
            </p>
          )}
          {v.connected && m.last_error && (
            <p className="ink-warn mt-1 text-xs [overflow-wrap:anywhere]" data-testid="hd-m365-mailbox-warning">
              {m.last_error_at ? `${fmt.dateTime(m.last_error_at)}: ` : ""}
              {m.last_error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {v.connected && !idle && m.failed > 0 && (
            <Button variant="secondary" size="sm" icon={<RotateCcw />} busy={retrying} disabled={disabled} onClick={onRetry} data-testid="hd-m365-retry">
              Try again
            </Button>
          )}
          {v.connected && !idle && (
            <Button variant="secondary" size="sm" icon={<RefreshCw />} busy={checking} disabled={disabled} onClick={onCheck}>
              Check now
            </Button>
          )}
          {manage && (
            <button type="button" className={iconButtonClass("quiet", "sm")} onClick={onDisconnect} data-tt="Disconnect" aria-label={`Disconnect ${m.address}`}>
              <Unplug aria-hidden />
            </button>
          )}
        </div>
      </div>
      {v.connected && !idle && <LastMessages m={m} />}
      {v.connected && manage && <LookupField m={m} />}
    </li>
  );
}

function Restrict({ v }: { v: M365MailView }) {
  const [probe, setProbe] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addresses = v.mailboxes.map((m) => m.address);
  const graphIds = Object.fromEntries(v.mailboxes.filter((m) => m.graph_id).map((m) => [m.address, m.graph_id]));
  const first = restrictCommands({ clientId: v.client_id, spObjectId: v.sp_object_id, addresses, first: true, graphIds });
  const later = restrictCommands({ clientId: v.client_id, spObjectId: v.sp_object_id, addresses, first: false, graphIds });

  async function check() {
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ access: M365AccessCheck; view: M365MailView }>(`${URL_}/check-access`, "POST", probe.trim() ? { probe: probe.trim() } : {}, "Couldn't check access.");
      setM365Mail(r.view);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <p className="text-sm text-slate-600">
        A Microsoft 365 app is normally given every mailbox in the organisation. This one is given none: an Exchange administrator allows it the mailboxes above and nothing else, with these
        commands. Microsoft has no way to do this step from here, so it is run once in Exchange Online PowerShell.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-500">
        {M365_ROLES.map((r) => (
          <li key={r.role}>
            {r.role}: {r.why}.
          </li>
        ))}
      </ul>
      {!first ? (
        <p className="mt-3 text-xs text-slate-500" data-testid="hd-m365-commands-empty">
          {addresses.length === 0 ? "Connect a mailbox first: the commands name each one." : "Press Check access once, so the desk learns the app's ID in your organisation. The commands appear here after that."}
        </p>
      ) : (
        <>
          <p className="mb-1 mt-3 text-xs font-medium text-slate-500">The first time (in PowerShell, with the ExchangeOnlineManagement module)</p>
          <pre className={PRE} data-testid="hd-m365-commands">{first}</pre>
          <div className="mt-2">
            <CopyButton text={first} label="Copy commands" />
          </div>
          <p className="mb-1 mt-4 text-xs font-medium text-slate-500">Later, when you connect or disconnect a mailbox</p>
          <pre className={PRE} data-testid="hd-m365-commands-later">{later}</pre>
          <div className="mt-2">
            <CopyButton text={later ?? ""} label="Copy commands" />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Microsoft can take from 30 minutes to 2 hours to apply a change. The last command shows what Exchange has on record at once: InScope should read True for both roles. The Get-EXOMailbox
            lines change nothing: they print each mailbox&apos;s sign-in name and object ID, for the Advanced field on a mailbox.
          </p>
        </>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label="A mailbox the desk should not reach (optional)" size="md" className="min-w-0 flex-1 basis-64">
          <TextInput type="email" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="you@yourcompany.com" autoComplete="off" maxLength={200} />
        </Field>
        <Button variant="secondary" icon={<ShieldCheck />} busy={busy} onClick={() => void check()}>
          Check access
        </Button>
      </div>
      <p className="mb-3 mt-1 text-xs text-slate-500">Name any other mailbox, such as your own, and the check proves the app is refused there.</p>
      <FormError className="mb-3">{error}</FormError>
      <AccessResult access={v.access} />
    </div>
  );
}

function AccessResult({ access }: { access: M365AccessCheck | null }) {
  const fmt = useFormatDate();
  if (!access) return <p className="text-xs text-slate-500" data-testid="hd-m365-access">Access has not been checked yet.</p>;
  const wide = access.tenant_wide;
  return (
    <div className="rounded-lg border border-slate-200 p-3" data-testid="hd-m365-access">
      <p className="text-xs font-medium text-slate-500">Checked {fmt.dateTime(access.at)}</p>
      <ul role="list" className="mt-1 space-y-1 text-sm">
        <li className={wide.length ? "ink-warn" : "text-slate-700"}>
          {wide.length
            ? `The app can reach every mailbox in your organisation (${wide.join(", ")} ${wide.length === 1 ? "is" : "are"} granted in Entra).`
            : "No organisation-wide mail permission is granted in Entra."}
        </li>
        {access.mailboxes.map((m) => (
          <li key={m.address} className={`[overflow-wrap:anywhere] ${m.ok ? "text-slate-700" : "ink-warn"}`}>
            {m.ok ? `${m.address}: the app can read it.` : `${m.address}: ${m.error}`}
          </li>
        ))}
        {access.probe && (
          <li className={`[overflow-wrap:anywhere] ${access.probe.reachable ? "ink-warn" : "text-slate-700"}`}>
            {access.probe.address}: {access.probe.note}
          </li>
        )}
      </ul>
      <p className="mt-2 text-xs text-slate-500">Sending is checked when a reply goes out, or with Send test on a help address that sends through Microsoft 365.</p>
    </div>
  );
}

function Options({ v }: { v: M365MailView }) {
  const id = useId();
  const [after, setAfter] = useState<M365AfterIntake>(v.after);
  const [folder, setFolder] = useState(v.folder);
  const [notifications, setNotifications] = useState(v.notifications);
  const [minutes, setMinutes] = useState(String(v.poll_minutes));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const n = Number(minutes);
  const minutesError = !Number.isInteger(n) || n < M365_MAIL_LIMITS.pollMin || n > M365_MAIL_LIMITS.pollMax ? `Between ${M365_MAIL_LIMITS.pollMin} and ${M365_MAIL_LIMITS.pollMax}.` : undefined;
  // Where this person has the desk open, when it is not where Microsoft posts notifications.
  const [here, setHere] = useState("");
  useEffect(() => setHere(window.location.origin), []);
  const elsewhere = !!here && here !== v.notify_origin;

  async function notifyHere() {
    setBusy(true);
    try {
      const r = await sendJson<{ view: M365MailView }>(URL_, "PATCH", { notify_here: true }, "Couldn't change the notification address.");
      setM365Mail(r.view);
      toast("ok", "Microsoft will notify the desk at this address.");
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dirty = after !== v.after || folder.trim() !== v.folder || notifications !== v.notifications || n !== v.poll_minutes;

  async function save() {
    setError("");
    if (minutesError) return;
    if (after === "move" && !folder.trim()) {
      setError("Give the folder a name.");
      return;
    }
    setBusy(true);
    try {
      const r = await sendJson<{ view: M365MailView }>(URL_, "PATCH", { after, folder: folder.trim() || v.folder, notifications, poll_minutes: n }, "Couldn't save the options.");
      setM365Mail(r.view);
      toast("ok", "Microsoft 365 options saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-slate-500">After a message is taken in</p>
        <RadioCards<M365AfterIntake>
          label="After a message is taken in"
          name={`${id}-after`}
          value={after}
          onChange={setAfter}
          options={[
            { value: "read", label: "Mark it as read", description: "The message stays in the Inbox, marked as read." },
            {
              value: "move",
              label: "Move it to a folder",
              description: "The message leaves the Inbox, marked as read. The folder is made if it is missing.",
              extra: (
                <Field label="Folder" size="sm">
                  <TextInput value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={M365_MAIL_LIMITS.folder} />
                </Field>
              ),
            },
          ]}
        />
        <p className="mt-2 text-xs text-slate-500">Mail the desk drops (an auto-reply, a duplicate, its own mail coming back) is marked or moved too. A message that could not be taken in is left as it is.</p>
      </div>
      <Toggle
        size="full"
        label="Notifications from Microsoft"
        help={
          v.notify_url_ok
            ? `Microsoft tells the desk at ${v.notify_origin} the moment mail arrives. Turn this off if Microsoft can't reach that address: the desk then reads on the timer alone.`
            : `Microsoft needs a public https address to notify. This desk was opened at ${v.notify_origin || "an address it can't reach"}, so it reads on the timer alone.`
        }
        checked={notifications}
        onChange={setNotifications}
      />
      {elsewhere && (
        <p className="text-xs text-slate-500" data-testid="hd-m365-notify-here">
          You have the desk open at {here}.{" "}
          <button type="button" className="link font-medium" onClick={() => void notifyHere()} disabled={busy}>
            Send notifications here
          </button>
        </p>
      )}
      <Field label="Check every (minutes)" size="lg" help="How often the desk reads a mailbox when notifications are off or not working. With notifications on it checks every 15 minutes as a safety net." error={minutesError}>
        <TextInput type="number" inputMode="numeric" className="max-w-40" min={M365_MAIL_LIMITS.pollMin} max={M365_MAIL_LIMITS.pollMax} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </Field>
      <FormError>{error}</FormError>
      <Button variant="secondary" size="sm" busy={busy} disabled={!dirty} onClick={() => void save()}>
        Save options
      </Button>
    </div>
  );
}

function AppRegistration({ v, manage }: { v: M365MailView; manage: boolean }) {
  const [replacing, setReplacing] = useState(false);

  async function remove() {
    const ok = await confirmDialog({
      title: "Remove the Microsoft 365 connection?",
      body: "The desk stops reading your mailboxes and sending through Microsoft 365 at once. The mailboxes stay listed, and nothing in them is changed. The app registration stays in Entra: delete it there if you no longer need it.",
      confirmLabel: "Remove connection",
      danger: true,
    });
    if (ok !== true) return;
    try {
      const r = await sendJson<{ view: M365MailView }>(URL_, "DELETE", undefined, "Couldn't remove the connection.");
      setM365Mail(r.view);
      toast("ok", "Microsoft 365 connection removed.");
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }

  return (
    <div className="mt-2">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-500">Tenant ID</dt>
        <dd className="break-all font-mono text-xs text-slate-700">{v.tenant}</dd>
        <dt className="text-slate-500">Application (client) ID</dt>
        <dd className="break-all font-mono text-xs text-slate-700">{v.client_id}</dd>
        <dt className="text-slate-500">Client secret</dt>
        <dd className="text-slate-700">Saved{v.secret_expires ? `, good until ${v.secret_expires}` : ""}. It is never shown.</dd>
        <dt className="text-slate-500">Set up</dt>
        <dd className="text-slate-700">{v.setup === "one_click" ? "With Microsoft, in one step" : "By hand"}</dd>
      </dl>
      {!manage && <p className="mt-3 text-xs text-slate-500">{ASK}</p>}
      {manage && replacing ? (
        <CredentialsForm className="mt-4" submit="Save app registration" tenant={v.tenant} clientId={v.client_id} keepSecret onSaved={() => setReplacing(false)} />
      ) : null}
      <div className={manage ? "mt-4 flex flex-wrap gap-2" : "hidden"}>
        {!replacing && (
          <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>
            Change app registration or secret
          </Button>
        )}
        {replacing && (
          <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void remove()}>
          Remove connection
        </Button>
      </div>
    </div>
  );
}

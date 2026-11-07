"use client";

// Desk settings → API and webhooks (1.19.4 C2, mock-up g1). Two cards:
//   API tokens   name + "cdh_…a91f", what the role lets it do, who it acts as
//                (shown-as name, role, teams), last used, expires; New token
//                shows the token once; Revoke… asks first.
//   Webhooks     endpoint, events, teams, the last delivery as a chip
//                ("200 · 2m ago" / "Failing · retrying" / "Off"); New
//                webhook shows the signing secret once; per row Edit, Send a
//                test, and a More menu (Delivery log, Rotate secret…, Turn
//                off / on, Delete…).
// GET /api/helpdesk/admin/api and its sub-routes (settings.manage). A token
// or secret is only ever in the answer that created it.

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Ban,
  History,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { chipClass, type ChipTone } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { confirmDialog } from "@/components/Dialog";
import { Field, FormError, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { RelativeTime } from "@/components/RelativeTime";
import { LoadingRow } from "@/components/Spinner";
import { TABLE_HEAD_ROW, TD, TH, TR, Table } from "@/components/Table";
import { toast } from "@/components/Toasts";
import {
  HD_API_EXPIRY_CHOICES,
  HD_WEBHOOK_DEFAULT_EVENTS,
  HD_WEBHOOK_EVENTS,
  HD_WEBHOOK_EVENT_HINT,
  HD_WEBHOOK_HEALTH_TONE,
  HD_WEBHOOK_SIGNATURE_HEADER,
  type HdApiOptions,
  type HdApiTokenRole,
  type HdApiTokenView,
  type HdDeliveryView,
  type HdWebhookEvent,
  type HdWebhookView,
} from "@/lib/helpdesk/api-shared";
import { getJson, sendJson } from "../api";

export const API_SUBTITLE = "Connect other tools to the helpdesk: they read and update tickets with a token, and hear about changes through webhooks.";

interface Data {
  tokens: HdApiTokenView[];
  webhooks: HdWebhookView[];
  options: HdApiOptions;
}

const origin = () => (typeof window === "undefined" ? "" : window.location.origin);

/** "Mar 1, 2027". */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function actsAs(t: HdApiTokenView): string {
  const teams = t.team_names.length ? t.team_names.join(", ") : "every team";
  return `${t.shown_as} (${t.role_label}, ${teams})`;
}

export function ApiWebhooksSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [hookEdit, setHookEdit] = useState<HdWebhookView | "new" | null>(null);
  const [logFor, setLogFor] = useState<HdWebhookView | null>(null);
  const [secret, setSecret] = useState<{ hook: HdWebhookView; secret: string; rotated: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getJson<Data>("/api/helpdesk/admin/api", "Couldn't load the API settings."));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) {
    return (
      <PageContainer>
        <PageHeader icon={<Webhook />} title="API and webhooks" subtitle={API_SUBTITLE} />
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </PageContainer>
    );
  }
  if (!data) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const tokens = data.tokens.filter((t) => !t.revoked_at);

  async function revoke(t: HdApiTokenView) {
    const ok = await confirmDialog({
      title: `Revoke ${t.name}?`,
      body: "The tool using it stops working at once: its next call is refused. What it already wrote stays, under its name.",
      confirmLabel: "Revoke token",
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/admin/api/tokens/${t.id}`, "DELETE", undefined, "Couldn't revoke the token.");
      toast("ok", `${t.name} revoked.`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function sendTest(h: HdWebhookView) {
    try {
      const r = await sendJson<{ delivery: HdDeliveryView }>(`/api/helpdesk/admin/api/webhooks/${h.id}/test`, "POST", undefined, "Couldn't send the test.");
      const d = r.delivery;
      if (d.state === "delivered") toast("ok", `Test delivered: HTTP ${d.response_status}.`);
      else toast("error", `Test failed: ${d.error || `HTTP ${d.response_status}`}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function rotate(h: HdWebhookView) {
    const ok = await confirmDialog({
      title: "Rotate the signing secret?",
      body: "A new secret signs every delivery from now on, and the old one stops at once. Update the receiver with the new secret straight away.",
      confirmLabel: "Rotate secret",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await sendJson<{ hook: HdWebhookView; secret: string }>(`/api/helpdesk/admin/api/webhooks/${h.id}/rotate`, "POST", undefined, "Couldn't rotate the secret.");
      setSecret({ hook: r.hook, secret: r.secret, rotated: true });
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function setEnabled(h: HdWebhookView, enabled: boolean) {
    if (!enabled) {
      const ok = await confirmDialog({
        title: "Turn this webhook off?",
        body: "Nothing more is sent to it, and deliveries still waiting for a retry are dropped. You can turn it back on.",
        confirmLabel: "Turn off",
      });
      if (!ok) return;
    }
    try {
      await sendJson(`/api/helpdesk/admin/api/webhooks/${h.id}`, "PATCH", { enabled }, "Couldn't change the webhook.");
      toast("ok", enabled ? "Webhook turned on." : "Webhook turned off.");
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove(h: HdWebhookView) {
    const ok = await confirmDialog({
      title: "Delete this webhook?",
      body: "It stops at once and its delivery log goes with it.",
      confirmLabel: "Delete webhook",
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson(`/api/helpdesk/admin/api/webhooks/${h.id}`, "DELETE", undefined, "Couldn't delete the webhook.");
      toast("ok", "Webhook deleted.");
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<Webhook />} title="API and webhooks" subtitle={API_SUBTITLE} />
      <div className="flex flex-col gap-4">
        <Card
          title="API tokens"
          padding="none"
          actions={
            <Button icon={<Plus />} onClick={() => setTokenOpen(true)}>
              New token
            </Button>
          }
        >
          {tokens.length === 0 ? (
            <SectionEmpty className="px-4 py-4" action={{ label: "Make the first token", onClick: () => setTokenOpen(true) }}>
              No tokens yet. Make one for each tool that reads or updates tickets.
            </SectionEmpty>
          ) : (
            <Table scroll minWidth="52rem">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={TH}>Name</th>
                  <th scope="col" className={TH}>Can</th>
                  <th scope="col" className={TH}>Acts as</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Last used</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Expires</th>
                  <th scope="col" className={`${TH} w-px`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className={TR}>
                    <td className={TD}>
                      <span className="block font-semibold text-slate-900">{t.name}</span>
                      <code className="mt-0.5 inline-block whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">{t.hint}</code>
                    </td>
                    <td className={`${TD} text-slate-600`}>{t.can}</td>
                    <td className={`${TD} text-slate-700`}>{actsAs(t)}</td>
                    <td className={`${TD} whitespace-nowrap text-slate-600`}>{t.last_used_at ? <RelativeTime value={t.last_used_at} /> : "Never"}</td>
                    <td className={`${TD} whitespace-nowrap text-slate-600`}>
                      {t.expired ? <span className="text-red-600">Expired</span> : t.expires_at ? shortDate(t.expires_at) : "Never"}
                    </td>
                    <td className={TD}>
                      <button type="button" className={iconButtonClass("quiet", "sm")} onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`} data-tt="Revoke">
                        <Ban aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Tokens act as a desk role you choose, with its teams. A token never sends a public reply unless its role can, and every call is in the audit log.
          </p>
        </Card>

        <Card
          title="Webhooks"
          padding="none"
          actions={
            <Button icon={<Plus />} onClick={() => setHookEdit("new")}>
              New webhook
            </Button>
          }
        >
          {data.webhooks.length === 0 ? (
            <SectionEmpty className="px-4 py-4" action={{ label: "Add the first webhook", onClick: () => setHookEdit("new") }}>
              No webhooks yet. Add one to tell another tool when tickets change.
            </SectionEmpty>
          ) : (
            <Table scroll minWidth="52rem">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={TH}>Endpoint</th>
                  <th scope="col" className={TH}>Events</th>
                  <th scope="col" className={TH}>Teams</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Last delivery</th>
                  <th scope="col" className={`${TH} w-px`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.webhooks.map((h) => (
                  <HookRow
                    key={h.id}
                    hook={h}
                    onEdit={() => setHookEdit(h)}
                    onTest={() => sendTest(h)}
                    onLog={() => setLogFor(h)}
                    onRotate={() => rotate(h)}
                    onEnabled={(on) => setEnabled(h, on)}
                    onDelete={() => remove(h)}
                  />
                ))}
              </tbody>
            </Table>
          )}
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Each delivery is signed (<code className="rounded bg-slate-100 px-1 font-mono text-slate-700">{HD_WEBHOOK_SIGNATURE_HEADER}</code>), retried for 24 hours, and listed with its response. Internal notes are only sent to webhooks set to include them.
          </p>
        </Card>
      </div>

      {tokenOpen && <TokenDialog options={data.options} onClose={() => setTokenOpen(false)} onCreated={load} />}
      {hookEdit && (
        <WebhookDialog
          hook={hookEdit === "new" ? null : hookEdit}
          options={data.options}
          onClose={() => setHookEdit(null)}
          onSaved={async (created) => {
            setHookEdit(null);
            if (created) setSecret({ ...created, rotated: false });
            else toast("ok", "Webhook saved.");
            await load();
          }}
        />
      )}
      {logFor && <DeliveriesDialog hook={logFor} onClose={() => setLogFor(null)} />}
      {secret && <SecretDialog {...secret} onClose={() => setSecret(null)} />}
    </PageContainer>
  );
}

// --- A webhook row ------------------------------------------------------------------------

function lastDeliveryChip(h: HdWebhookView): { tone: ChipTone; text: React.ReactNode; tt?: string } {
  if (h.health === "off") return { tone: HD_WEBHOOK_HEALTH_TONE.off, text: "Off", tt: h.disabled_reason || "Turned off" };
  if (h.health === "failing") return { tone: HD_WEBHOOK_HEALTH_TONE.failing, text: h.pending ? "Failing · retrying" : "Failing" };
  if (!h.last_delivery) return { tone: HD_WEBHOOK_HEALTH_TONE.new, text: "No deliveries yet" };
  return {
    tone: HD_WEBHOOK_HEALTH_TONE.ok,
    text: (
      <>
        {h.last_delivery.status ?? "Sent"} · <RelativeTime value={h.last_delivery.at} />
      </>
    ),
  };
}

function HookRow({
  hook: h,
  onEdit,
  onTest,
  onLog,
  onRotate,
  onEnabled,
  onDelete,
}: {
  hook: HdWebhookView;
  onEdit: () => void;
  onTest: () => void;
  onLog: () => void;
  onRotate: () => void;
  onEnabled: (on: boolean) => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [testing, setTesting] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const chip = lastDeliveryChip(h);
  const label = h.name || h.url;
  return (
    <tr className={TR}>
      <td className={`${TD} max-w-[22rem]`}>
        {h.name && <span className="mb-0.5 block truncate font-semibold text-slate-900">{h.name}</span>}
        <code className="inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 align-bottom font-mono text-xs text-slate-700">{h.url}</code>
      </td>
      <td className={`${TD} text-slate-700`}>{h.events.join(", ")}{h.include_notes ? <span className="block text-xs text-slate-500">Includes internal notes</span> : null}</td>
      <td className={`${TD} text-slate-700`}>{h.team_names.length ? h.team_names.join(", ") : "All"}</td>
      <td className={`${TD} whitespace-nowrap`}>
        <span className={chipClass(chip.tone, "sm")} {...(chip.tt ? { "data-tt": chip.tt, tabIndex: 0 } : {})}>
          {chip.text}
        </span>
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <span className="flex items-center gap-1">
          <button type="button" className={iconButtonClass("quiet", "sm")} onClick={onEdit} aria-label={`Edit ${label}`} data-tt="Edit">
            <Pencil aria-hidden />
          </button>
          <button
            type="button"
            className={iconButtonClass("quiet", "sm")}
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              try {
                await onTest();
              } finally {
                setTesting(false);
              }
            }}
            aria-label={`Send a test to ${label}`}
            data-tt="Send a test"
          >
            <Send aria-hidden />
          </button>
          <button
            ref={more}
            type="button"
            className={iconButtonClass("quiet", "sm")}
            onClick={() => setMenu((o) => !o)}
            aria-label={`More actions for ${label}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            data-tt="More"
          >
            <MoreHorizontal aria-hidden />
          </button>
          <Popover open={menu} onClose={() => setMenu(false)} triggerRef={more} role="menu" label={`Actions for ${label}`} align="end" width="w-56">
            <MenuItem icon={<History />} onClick={() => (setMenu(false), onLog())}>
              Delivery log
            </MenuItem>
            <MenuItem icon={<RotateCcw />} onClick={() => (setMenu(false), onRotate())}>
              Rotate secret…
            </MenuItem>
            <MenuItem icon={<Power />} onClick={() => (setMenu(false), onEnabled(!h.enabled))}>
              {h.enabled ? "Turn off…" : "Turn on"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onClick={() => (setMenu(false), onDelete())}>
              Delete…
            </MenuItem>
          </Popover>
        </span>
      </td>
    </tr>
  );
}

// --- Shown once -------------------------------------------------------------------------------

function ShownOnce({ what, value, children }: { what: "token" | "secret"; value: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="notice-ok rounded-lg border p-4 text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-4 w-4" aria-hidden />
          Copy the {what} now. It won&apos;t be shown again.
        </p>
        <p className="mt-1">Only {what === "token" ? "a fingerprint of it is kept. If it is lost, revoke it and make a new one." : "a sealed copy is kept for signing. If it is lost, rotate it."}</p>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">{what === "token" ? "API token" : "Signing secret"}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code data-testid={`hd-api-${what}`} className="min-w-0 max-w-full break-all rounded-md border border-slate-200 bg-canvas px-2 py-1.5 font-mono text-xs text-slate-700">
            {value}
          </code>
          <CopyButton text={value} label={what === "token" ? "Copy token" : "Copy secret"} variant="primary" />
        </div>
      </div>
      {children}
    </div>
  );
}

function ModalHead({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <h2 id={id} className="text-base font-semibold text-slate-900">
        {title}
      </h2>
      <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
        <X aria-hidden />
      </button>
    </div>
  );
}

const MODAL = "max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal";

// --- New token ---------------------------------------------------------------------------------

function TeamChecks({ teams, chosen, onChange, legend, help }: { teams: { id: number; name: string }[]; chosen: number[]; onChange: (ids: number[]) => void; legend: string; help: string }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-slate-500">{legend}</legend>
      {teams.length === 0 ? (
        <SectionEmpty>No teams yet.</SectionEmpty>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {teams.map((t) => (
            <label key={t.id} className="flex min-w-0 items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={chosen.includes(t.id)}
                onChange={(e) => onChange(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))}
              />
              <span className="truncate">{t.name}</span>
            </label>
          ))}
        </div>
      )}
      <p className="mt-1 text-xs text-slate-500">{help}</p>
    </fieldset>
  );
}

function expiryDate(choice: string, custom: string): string | null {
  if (choice === "never") return null;
  if (choice === "custom") return custom || "";
  const d = new Date(Date.now() + Number(choice) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Mounted only while open, so each opening starts clean and a reload of the page behind it never clears the token shown once. */
function TokenDialog({ options, onClose, onCreated }: { options: HdApiOptions; onClose: () => void; onCreated: () => void }) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [shownAs, setShownAs] = useState("");
  const [role, setRole] = useState<HdApiTokenRole | "">(() => options.roles.find((r) => r.value === "agent")?.value ?? options.roles[0]?.value ?? "");
  const [teams, setTeams] = useState<number[]>(() => (options.teams.length === 1 ? [options.teams[0].id] : []));
  const [expiry, setExpiry] = useState<string>("365");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState<string | null>(null);

  const roleInfo = options.roles.find((r) => r.value === role);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const expires_at = expiryDate(expiry, custom);
    if (expires_at === "") return setError("Choose the date it expires.");
    setBusy(true);
    try {
      const r = await sendJson<{ token: string }>("/api/helpdesk/admin/api/tokens", "POST", { name, shown_as: shownAs, role, team_ids: teams, expires_at }, "Couldn't make the token.");
      setMade(r.token);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const curl = made ? `curl -H "Authorization: Bearer ${made}" ${origin()}${options.base_path}/me` : "";

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className={MODAL}>
      <ModalHead id={titleId} title={made ? "Token made" : "New API token"} onClose={onClose} />
      {made ? (
        <div className="mt-4">
          <ShownOnce what="token" value={made}>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">Try it</p>
                <CopyButton text={curl} label="Copy command" />
              </div>
              <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-canvas p-3 font-mono text-xs leading-5 text-slate-700">{curl}</pre>
              <p className="mt-1 text-xs text-slate-500">
                The API lives at <code className="font-mono">{options.base_path}</code>. Send the token as Authorization: Bearer &lt;token&gt;. Treat it like a password.
              </p>
            </div>
          </ShownOnce>
          <div className="mt-5 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="mt-4 space-y-3">
            <Field label="Name" help="The tool that will use it, so you know which token to revoke.">
              <TextInput data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Jira sync" />
            </Field>
            <Field label="Shown as" help="The name on the notes, replies and changes it makes. Leave empty to use the token's name.">
              <TextInput value={shownAs} onChange={(e) => setShownAs(e.target.value)} maxLength={80} placeholder="Helpdesk bot" />
            </Field>
            <Field label="Acts as" help={roleInfo ? `Can: ${roleInfo.can}.` : "You can't hand out a desk role."}>
              <Select value={role} onChange={(e) => setRole(e.target.value as HdApiTokenRole)}>
                {options.roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <TeamChecks
              legend="With these teams"
              teams={options.teams}
              chosen={teams}
              onChange={setTeams}
              help="It works these teams' tickets, as someone with that role in them would. A Manager sees every team."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Expires">
                <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  {HD_API_EXPIRY_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {expiry === "custom" && (
                <Field label="On" help="At the end of that day (UTC).">
                  <TextInput type="date" value={custom} onChange={(e) => setCustom(e.target.value)} />
                </Field>
              )}
            </div>
            <FormError>{error}</FormError>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={!options.roles.length}>
              Create token
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// --- New / edit webhook ----------------------------------------------------------------------------

function WebhookDialog({
  hook,
  options,
  onClose,
  onSaved,
}: {
  hook: HdWebhookView | null;
  options: HdApiOptions;
  onClose: () => void;
  onSaved: (created: { hook: HdWebhookView; secret: string } | null) => void;
}) {
  const titleId = useId();
  const [url, setUrl] = useState(hook?.url ?? "");
  const [name, setName] = useState(hook?.name ?? "");
  const [events, setEvents] = useState<HdWebhookEvent[]>(hook?.events ?? [...HD_WEBHOOK_DEFAULT_EVENTS]);
  const [teams, setTeams] = useState<number[]>(hook?.team_ids ?? []);
  const [notes, setNotes] = useState(hook?.include_notes ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const body = { url, name, events, team_ids: teams, include_notes: notes };
    try {
      if (hook) {
        await sendJson(`/api/helpdesk/admin/api/webhooks/${hook.id}`, "PATCH", body, "Couldn't save the webhook.");
        onSaved(null);
      } else {
        onSaved(await sendJson<{ hook: HdWebhookView; secret: string }>("/api/helpdesk/admin/api/webhooks", "POST", body, "Couldn't add the webhook."));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The admin's own team list; a hook may already name teams outside it (another admin's choice): keep them listed.
  const teamList = [...options.teams, ...(hook?.team_ids ?? []).filter((id) => !options.teams.some((t) => t.id === id)).map((id, i) => ({ id, name: hook?.team_names[i] ?? `Team ${id}` }))];

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className={MODAL}>
      <form onSubmit={submit} noValidate>
        <ModalHead id={titleId} title={hook ? "Edit webhook" : "New webhook"} onClose={onClose} />
        <div className="mt-4 space-y-3">
          <Field label="Endpoint" help="An https address. Deliveries are POSTed as JSON and signed with a secret you'll see once.">
            <TextInput data-autofocus type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} placeholder="https://acme.atlassian.net/…/compassdocs" />
          </Field>
          <Field label="Name (optional)">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Jira" />
          </Field>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-slate-500">Events</legend>
            <div className="space-y-1.5">
              {HD_WEBHOOK_EVENTS.map((ev) => (
                <label key={ev} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={events.includes(ev)}
                    onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
                  />
                  <span className="min-w-0">
                    <code className="font-mono text-xs text-slate-800">{ev}</code>
                    <span className="block text-xs text-slate-500">{HD_WEBHOOK_EVENT_HINT[ev]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <TeamChecks
            legend="Teams"
            teams={teamList}
            chosen={teams}
            onChange={setTeams}
            help={
              options.all_teams
                ? "It hears about these teams' tickets only. Leave all unticked for every team (tickets without a team too)."
                : "It hears about these teams' tickets only, so choose at least one of yours."
            }
          />
          <Toggle
            label="Include internal notes"
            help="Send note.created events with the note's text. Off: notes never leave the desk."
            checked={notes}
            onChange={setNotes}
          />
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {hook ? "Save webhook" : "Add webhook"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SecretDialog({ hook, secret, rotated, onClose }: { hook: HdWebhookView; secret: string; rotated: boolean; onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal open onClose={onClose} labelledBy={titleId} className={MODAL}>
      <ModalHead id={titleId} title={rotated ? "New signing secret" : "Webhook added"} onClose={onClose} />
      <div className="mt-4">
        <ShownOnce what="secret" value={secret}>
          <div className="text-sm text-slate-700">
            <p className="font-medium text-slate-800">Check each delivery</p>
            <p className="mt-1 text-xs text-slate-500">
              <code className="font-mono">{HD_WEBHOOK_SIGNATURE_HEADER}: t=&lt;unix time&gt;,v1=&lt;signature&gt;</code>. The signature is the hex HMAC-SHA256 of
              &quot;t.body&quot; (the time, a dot, then the raw body) with this secret. Refuse a time more than five minutes old. X-CompassDocs-Delivery is the
              same on retries.
            </p>
            <p className="mt-2 text-xs text-slate-500">Endpoint: <code className="break-all font-mono">{hook.url}</code></p>
          </div>
        </ShownOnce>
        <div className="mt-5 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Delivery log --------------------------------------------------------------------------------

const OUTCOME: Record<HdDeliveryView["state"], { tone: ChipTone; label: (d: HdDeliveryView) => string }> = {
  delivered: { tone: "ok", label: () => "Delivered" },
  queued: { tone: "warn", label: (d) => (d.attempts ? "Retrying" : "Queued") },
  sending: { tone: "info", label: () => "Sending" },
  failed: { tone: "error", label: () => "Failed" },
};

function DeliveriesDialog({ hook, onClose }: { hook: HdWebhookView; onClose: () => void }) {
  const titleId = useId();
  const [rows, setRows] = useState<HdDeliveryView[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await getJson<{ deliveries: HdDeliveryView[] }>(`/api/helpdesk/admin/api/webhooks/${hook.id}/deliveries`, "Couldn't load the delivery log.");
      setRows(r.deliveries);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [hook.id]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Delivery log
          </h2>
          <p className="truncate font-mono text-xs text-slate-500">{hook.url}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={load} disabled={busy} aria-label="Refresh the delivery log" data-tt="Refresh" className={iconButtonClass("bordered", "sm")}>
            <RefreshCw aria-hidden />
          </button>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
            <X aria-hidden />
          </button>
        </span>
      </div>
      <div className="mt-4">
        {error && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>}
        {rows === null && !error && <LoadingRow className="py-6" />}
        {rows && rows.length === 0 && <SectionEmpty>Nothing sent yet. Deliveries show here with the endpoint&apos;s answer.</SectionEmpty>}
        {rows && rows.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <Table scroll minWidth="40rem">
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>When</th>
                  <th scope="col" className={TH}>Event</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Outcome</th>
                  <th scope="col" className={`${TH} w-px whitespace-nowrap`}>Code</th>
                  <th scope="col" className={TH}>Answer</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const o = OUTCOME[d.state];
                  const at = d.last_attempt_at ?? d.created_at;
                  return (
                    <tr key={d.id} className={`${TR} align-top`}>
                      <td className={`${TD} whitespace-nowrap text-slate-600`}>
                        <RelativeTime value={at} />
                      </td>
                      <td className={`${TD} text-slate-700`}>
                        <code className="font-mono text-xs">{d.event}</code>
                        {d.ticket_number ? <span className="block text-xs text-slate-500">#{d.ticket_number}</span> : null}
                        {d.test ? <span className="block text-xs text-slate-500">Test</span> : null}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <span className={chipClass(o.tone, "sm")}>{o.label(d)}</span>
                        {d.attempts > 1 && <span className="block text-xs text-slate-500">{d.attempts} attempts</span>}
                        {d.state === "queued" && d.next_attempt_at && (
                          <span className="block text-xs text-slate-500">
                            next <RelativeTime value={d.next_attempt_at} />
                          </span>
                        )}
                      </td>
                      <td className={`${TD} whitespace-nowrap font-mono text-xs ${d.response_status && d.response_status >= 400 ? "text-red-600" : "text-slate-700"}`}>
                        {d.response_status ?? <span className="sr-only">None</span>}
                      </td>
                      <td className={`${TD} min-w-0 text-xs text-slate-600`}>
                        {d.error && <span className="block">{d.error}</span>}
                        {d.response_excerpt && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-slate-500">Response (first 2 KB)</summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-200 bg-canvas p-2 font-mono text-2xs text-slate-700">
                              {d.response_excerpt}
                            </pre>
                          </details>
                        )}
                        
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">The newest 50 finished deliveries are kept, with the first 2 KB of each answer. A delivery is retried for 24 hours.</p>
      </div>
    </Modal>
  );
}

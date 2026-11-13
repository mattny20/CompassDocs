"use client";

// Settings → Email: the addresses people write to (1.20.2,
// lib/helpdesk/mailboxes: each with its From name, the team its tickets
// start in and the address its replies go out from), the send-from
// addresses those are picked from (1.20.5, lib/helpdesk/send-addresses: a
// second list on this page, under the first, because a help address's
// dialog picks from it), the one webhook every address is forwarded to,
// whether mail from outside the workspace may open tickets, and whether a
// sender's address is trusted when the provider reports no SPF/DKIM result
// (lib/helpdesk/inbound). Both lists act at once (add, edit, remove, send
// test); the two "Who can write in" switches save through the page's Save
// row. Adding the first address ticks the setup checklist's Email step.

import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound, Mail, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { Field, FormError, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { Tooltip } from "@/components/Tooltip";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { useFormatDate } from "@/components/SettingsProvider";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { MAILBOX_LIMITS, cleanMailboxAddress, mailboxAddressProblem, sendAddressProblem } from "@/lib/helpdesk/mailboxes-shared";
import type { HdMailboxView, HdSendAddressView } from "@/lib/helpdesk/mailboxes-shared";
import type { HdSettings } from "@/lib/helpdesk/types";
import { getJson, sendJson } from "../api";
import { forgetDeskMailboxes } from "../mailboxes";
import { useCan } from "../me";

type PublicSettings = Omit<HdSettings, "inbound_secret"> & { inbound_enabled: boolean; trust_unverified_senders: boolean };
interface MailboxData {
  mailboxes: HdMailboxView[];
  teams: { id: number; name: string }[];
  mail_ready: boolean;
  transport_from: string;
  /** 1.20.5: the send-from addresses (the second list, and the dialog's "Send replies from"). */
  send_addresses: HdSendAddressView[];
  send_address_limit: number;
}

const NO_TEAM = "No team (use routing)";
const WORKSPACE_ADDRESS = "The workspace address";
/** "a", "a and b", "a, b and c". */
const sentenceList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const MODAL = "max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal";

export function EmailSettings() {
  const can = useCan();
  const fmt = useFormatDate();
  const [s, setS] = useState<PublicSettings | null>(null);
  const [path, setPath] = useState("");
  const [boxes, setBoxes] = useState<MailboxData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<HdMailboxView | "new" | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [editingSender, setEditingSender] = useState<HdSendAddressView | "new" | null>(null);
  const [testingSender, setTestingSender] = useState<number | null>(null);
  const snap = JSON.stringify(s && { o: s.outside_senders, t: s.trust_unverified_senders });
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  const loadBoxes = useCallback(() => {
    // The queue's own copy of the list (the Address filter, the address on a row) is read again after a change here.
    forgetDeskMailboxes();
    return getJson<MailboxData>("/api/helpdesk/admin/mailboxes", "Couldn't load the addresses.")
      .then(setBoxes)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    getJson<{ settings: PublicSettings; inbound_path: string }>("/api/helpdesk/admin/settings", "Couldn't load the email settings.")
      .then((d) => {
        setS(d.settings);
        setPath(d.inbound_path || "");
      })
      .catch((e: Error) => setError(e.message));
    void loadBoxes();
  }, [loadBoxes]);

  if (error && (!s || !boxes)) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!s || !boxes) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const url = path ? `${typeof window === "undefined" ? "" : window.location.origin}${path}` : "";
  const list = boxes.mailboxes;
  const senders = boxes.send_addresses ?? [];
  const senderLimit = boxes.send_address_limit || 200;
  const fallback = list.find((m) => m.is_default) ?? list[0];
  const set = (p: Partial<PublicSettings>) => {
    markDirty();
    setS({ ...s, ...p });
  };

  async function save(extra: Record<string, unknown> = {}) {
    if (!s) return;
    setBusy(true);
    try {
      // Ticking the setup checklist needs settings.manage: send it only when
      // it changes and the person may, so channels.manage alone can save.
      const done = s.setup_steps_done ?? [];
      const tick = !done.includes("email") && can("settings.manage") ? { setup_steps_done: [...done, "email"] } : {};
      const d = await sendJson<{ settings: PublicSettings; inbound_path: string }>(
        "/api/helpdesk/admin/settings",
        "PATCH",
        { outside_senders: s.outside_senders, trust_unverified_senders: s.trust_unverified_senders === true, ...tick, ...extra },
        "Couldn't save the email settings."
      );
      markClean(snap);
      setS(d.settings);
      setPath(d.inbound_path || "");
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    const ok = await confirmDialog({
      title: path ? "Make a new webhook address?" : "Turn on inbound email?",
      body: path
        ? "The old address stops working at once. Paste the new one into your mail provider straight away, or mail sent in the meantime is refused."
        : "Makes the private webhook address your mail provider posts incoming mail to.",
      confirmLabel: path ? "Make a new address" : "Turn on",
      danger: !!path,
    });
    if (ok !== true) return;
    if (await save({ rotate_inbound_secret: true })) toast("ok", path ? "New webhook address made." : "Inbound email is on.");
  }

  async function remove(m: HdMailboxView) {
    const heir = m.is_default ? list.find((x) => x.id !== m.id) : fallback;
    const tickets = m.tickets === 1 ? "1 ticket came" : `${m.tickets} tickets came`;
    const moved = m.tickets > 0 && heir ? ` ${tickets} in on it: ${m.tickets === 1 ? "it moves" : "they move"} to ${heir.address}, and replies go out from there.` : "";
    const promoted = m.is_default && heir ? ` ${heir.address} becomes the default.` : "";
    const last = !heir ? " The desk will have no address: replies go out with no reply address until you add one." : "";
    const ok = await confirmDialog({
      title: `Remove ${m.address}?`,
      body: `Mail sent to it is treated as mail to the default address.${moved}${promoted}${last}`,
      confirmLabel: "Remove address",
      danger: true,
    });
    if (ok !== true) return;
    try {
      const r = await sendJson<{ moved: number; moved_to: { address: string } | null }>(`/api/helpdesk/admin/mailboxes/${m.id}`, "DELETE", undefined, "Couldn't remove the address.");
      toast("ok", r.moved > 0 && r.moved_to ? `Address removed. ${r.moved === 1 ? "1 ticket" : `${r.moved} tickets`} moved to ${r.moved_to.address}.` : "Address removed.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
    await loadBoxes();
  }

  async function sendTest(m: HdMailboxView) {
    setTesting(m.id);
    try {
      const r = await sendJson<{ ok: boolean; to: string; from: string; error?: string }>(`/api/helpdesk/admin/mailboxes/${m.id}/test`, "POST", {}, "Couldn't send the test.");
      if (r.ok) toast("ok", `Test sent to ${r.to} from ${r.from}.`);
      else toast("error", `Your mail provider refused the test from ${r.from || m.address}: ${r.error ?? "no reason given"}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setTesting(null);
    }
    await loadBoxes();
  }

  async function removeSender(sa: HdSendAddressView) {
    const users = sa.used_by.map((m) => m.address);
    const ok = await confirmDialog({
      title: `Remove ${sa.address}?`,
      body: users.length
        ? `${sentenceList(users)} ${users.length === 1 ? "sends" : "send"} replies from it. ${users.length === 1 ? "It goes" : "They go"} back to the workspace address${boxes?.transport_from ? ` (${boxes.transport_from})` : ""}. Answers still come back to ${users.length === 1 ? "that help address" : "those help addresses"}.`
        : "No help address sends from it, so nothing else changes.",
      confirmLabel: "Remove address",
      danger: true,
    });
    if (ok !== true) return;
    try {
      const r = await sendJson<{ released: { address: string }[] }>(`/api/helpdesk/admin/send-addresses/${sa.id}`, "DELETE", undefined, "Couldn't remove the send-from address.");
      const n = r.released?.length ?? 0;
      toast("ok", n > 0 ? `Send-from address removed. ${n === 1 ? "1 help address now sends" : `${n} help addresses now send`} from the workspace address.` : "Send-from address removed.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
    await loadBoxes();
  }

  async function sendSenderTest(sa: HdSendAddressView) {
    setTestingSender(sa.id);
    try {
      const r = await sendJson<{ ok: boolean; to: string; from: string; error?: string }>(`/api/helpdesk/admin/send-addresses/${sa.id}/test`, "POST", {}, "Couldn't send the test.");
      if (r.ok) toast("ok", `Test sent to ${r.to} from ${r.from}.`);
      else if (!r.from) toast("error", r.error ?? "Couldn't send the test.");
      else toast("error", `Your mail provider refused the test from ${r.from}: ${r.error ?? "no reason given"}`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setTestingSender(null);
    }
    await loadBoxes();
  }

  const workspaceFrom = boxes.transport_from || "your workspace's mail address";
  const anyTest = testing !== null || testingSender !== null;

  return (
    <PageContainer>
      <PageHeader icon={<Mail />} title="Email" subtitle="Forward your help addresses here, and replies thread back into the ticket." />
      <div className="flex flex-col gap-4">
        <Card
          id="addresses"
          className="scroll-mt-6"
          padding="none"
          title="Addresses"
          description="The addresses people write to. Each has its own name on replies, and can start its tickets in its own team."
          actions={
            <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setEditing("new")}>
              Add address
            </Button>
          }
        >
          {list.length === 0 ? (
            <SectionEmpty className="px-4 py-6" action={{ label: "Add address", onClick: () => setEditing("new") }}>
              No addresses yet. Add the one people write to, such as help@yourcompany.com, and replies will carry it as their reply address.
            </SectionEmpty>
          ) : (
            <ul role="list" className="divide-y divide-slate-100" data-testid="hd-mailboxes">
              {list.map((m) => (
                <li key={m.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3" data-testid="hd-mailbox-row">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 break-all text-sm font-medium text-slate-900">{m.address}</span>
                      {m.is_default && <Chip tone="info" size="sm">Default</Chip>}
                      {m.send_from && <Chip tone="accent" size="sm">Sends from this address</Chip>}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 [overflow-wrap:anywhere]">
                      <span className="sr-only">Replies are from </span>
                      {m.name} · {m.team_name ?? NO_TEAM}
                      {m.tickets > 0 && <> · {m.tickets === 1 ? "1 ticket" : `${m.tickets} tickets`}</>}
                      {m.send_address && !m.send_from && <span data-testid="hd-mailbox-sends-from"> · Sends from {m.send_address}</span>}
                    </p>
                    {m.send_address && m.send_from_error && (
                      <p className="ink-warn mt-1 text-xs [overflow-wrap:anywhere]" data-testid="hd-mailbox-warning">
                        Your mail provider refused mail from {m.send_from ? "this address" : m.send_address}{m.send_from_error_at ? ` on ${fmt.dateTime(m.send_from_error_at)}` : ""}: {m.send_from_error} Replies go out from {workspaceFrom} under this name until a test goes through.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="secondary" size="sm" icon={<Send />} busy={testing === m.id} disabled={anyTest} onClick={() => void sendTest(m)}>
                      Send test
                    </Button>
                    <button type="button" className={iconButtonClass("quiet", "sm")} onClick={() => setEditing(m)} data-tt="Edit" aria-label={`Edit ${m.address}`}>
                      <Pencil aria-hidden />
                    </button>
                    <button type="button" className={iconButtonClass("quiet", "sm")} onClick={() => void remove(m)} data-tt="Remove" aria-label={`Remove ${m.address}`}>
                      <Trash2 aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Replies about a ticket go out under the name of the address it came in on, and answers come back to that address. Each address sends its replies from {workspaceFrom},
            or from a send-from address you pick when you edit it. Send test goes to your own email and shows how a reply leaves.
            {!boxes.mail_ready && " Outgoing mail isn't set up yet, so nothing is sent."}
          </p>
        </Card>

        <Card
          id="send-from"
          className="scroll-mt-6"
          padding="none"
          title="Send-from addresses"
          description="The addresses replies can go out from. Add as many as you need, then pick one when you edit a help address."
          actions={
            senders.length >= senderLimit ? (
              <Tooltip label={`Up to ${senderLimit} send-from addresses.`}>
                <Button variant="secondary" size="sm" icon={<Plus />} disabled>
                  Add send-from address
                </Button>
              </Tooltip>
            ) : (
              <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setEditingSender("new")}>
                Add send-from address
              </Button>
            )
          }
        >
          {senders.length === 0 ? (
            <SectionEmpty className="px-4 py-6" action={{ label: "Add send-from address", onClick: () => setEditingSender("new") }}>
              No send-from addresses yet. Replies go out from {workspaceFrom}. Add an address your mail provider lets you send from, such as support@yourcompany.com, then pick it on a help address.
            </SectionEmpty>
          ) : (
            <ul role="list" className="divide-y divide-slate-100" data-testid="hd-send-addresses">
              {senders.map((sa) => (
                <li key={sa.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3" data-testid="hd-send-address-row">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="min-w-0 break-all text-sm font-medium text-slate-900">{sa.address}</p>
                    <p className="mt-0.5 text-xs text-slate-500 [overflow-wrap:anywhere]">
                      {sa.name ? <>From name: {sa.name}</> : "Uses the help address's name"}
                      <span data-testid="hd-send-address-used-by"> · {sa.used_by.length > 0 ? `Used by ${sentenceList(sa.used_by.map((m) => m.address))}` : "Not used by a help address"}</span>
                    </p>
                    {sa.last_error && (
                      <p className="ink-warn mt-1 text-xs [overflow-wrap:anywhere]" data-testid="hd-send-address-warning">
                        Your mail provider refused mail from this address{sa.last_error_at ? ` on ${fmt.dateTime(sa.last_error_at)}` : ""}: {sa.last_error} Replies go out from {workspaceFrom} until a test goes through.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="secondary" size="sm" icon={<Send />} busy={testingSender === sa.id} disabled={anyTest} onClick={() => void sendSenderTest(sa)}>
                      Send test
                    </Button>
                    <button type="button" className={iconButtonClass("quiet", "sm")} onClick={() => setEditingSender(sa)} data-tt="Edit" aria-label={`Edit send-from address ${sa.address}`}>
                      <Pencil aria-hidden />
                    </button>
                    <button type="button" className={iconButtonClass("quiet", "sm")} onClick={() => void removeSender(sa)} data-tt="Remove" aria-label={`Remove send-from address ${sa.address}`}>
                      <Trash2 aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Mail goes out through your workspace mail server (Settings, Notifications, Email). Your mail provider, such as SMTP2GO, must allow each address: verify the sender or its
            domain there first. Send test goes to your own email and shows the provider&apos;s answer. Answers to a reply always come back to the help address, whatever address the
            reply was sent from.
          </p>
        </Card>

        <Card title="Webhook" description="One webhook takes the mail for every address. Forward each of your addresses to this webhook.">
          {path ? (
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">Webhook address (keep it private)</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 max-w-full truncate rounded-md border border-slate-200 bg-canvas px-2 py-1.5 font-mono text-xs text-slate-700">{url}</code>
                <CopyButton text={url} label="Copy address" />
                <Button variant="secondary" size="sm" icon={<KeyRound />} onClick={rotate} disabled={busy}>
                  Make a new address
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Set it as the inbound webhook (inbound parse) in Postmark, SendGrid or Mailgun, or POST JSON with from, to, subject and text from any other service. The desk reads who
                the mail was sent to (To, Cc and the envelope recipient) to tell your addresses apart; mail to none of them counts as mail to the default.
                Your provider must check SPF and DKIM: Postmark and Mailgun (with spam filtering on) add the results to each message, SendGrid sends them as fields.
                Other services: add spf, dkim and dmarc results, or forward the receiving server&apos;s Authentication-Results header.
              </p>
            </div>
          ) : (
            <div className="notice-warn flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">Inbound email is off: mail to your addresses doesn&apos;t reach the desk yet.</span>
              <Button variant="secondary" size="sm" onClick={rotate} disabled={busy}>
                Turn on
              </Button>
            </div>
          )}
        </Card>

        <Card title="Who can write in">
          <Toggle
            label="Accept mail from outside the workspace"
            help="Off: only people with a CompassDocs account can open tickets by email. Mail from addresses outside your workspace is ignored and logged. No reply is sent, so forged senders can't be used to send mail through you."
            checked={s.outside_senders}
            onChange={(v) => set({ outside_senders: v })}
          />
          <div className="mt-4">
            <Toggle
              label="Trust sender addresses without SPF or DKIM results"
              help="Mail is linked to someone's account only when your mail provider confirms the sender's domain passed SPF, DKIM or DMARC. Without a result it is treated as mail from outside the workspace and can't reply into an existing ticket. Turn this on only if your provider reports no results: anyone can then send mail that looks like it came from a colleague. A failed check is never trusted."
              checked={s.trust_unverified_senders === true}
              onChange={(v) => set({ trust_unverified_senders: v })}
            />
          </div>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={() => void save().then((ok) => ok && toast("ok", "Email settings saved."))} label="Save email settings" />
      {editing && (
        <AddressDialog
          box={editing === "new" ? null : editing}
          first={list.length === 0}
          teams={boxes.teams}
          senders={senders}
          workspaceFrom={workspaceFrom}
          transportFrom={boxes.transport_from}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            toast("ok", msg);
            void loadBoxes();
          }}
        />
      )}
      {editingSender && (
        <SendAddressDialog
          sender={editingSender === "new" ? null : editingSender}
          onClose={() => setEditingSender(null)}
          onSaved={(msg) => {
            setEditingSender(null);
            toast("ok", msg);
            void loadBoxes();
          }}
        />
      )}
    </PageContainer>
  );
}

function AddressDialog({
  box,
  first,
  teams,
  senders,
  workspaceFrom,
  transportFrom,
  onClose,
  onSaved,
}: {
  box: HdMailboxView | null;
  /** No address is listed yet: this one is the default whatever is chosen. */
  first: boolean;
  teams: { id: number; name: string }[];
  /** The send-from addresses "Send replies from" offers (1.20.5). */
  senders: HdSendAddressView[];
  workspaceFrom: string;
  /** The workspace mail server's own address ('' when none is set). */
  transportFrom: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const titleId = useId();
  const [address, setAddress] = useState(box?.address ?? "");
  const [name, setName] = useState(box?.name ?? "");
  const [team, setTeam] = useState(box?.team_id ? String(box.team_id) : "");
  // "" = the workspace address, a send-from address's id, or "own" = this address itself (not on the list yet).
  const [sendFrom, setSendFrom] = useState(box?.send_address_id ? String(box.send_address_id) : "");
  const [isDefault, setIsDefault] = useState(box?.is_default ?? first);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const addressError = tried ? mailboxAddressProblem(address) || undefined : undefined;
  const nameError = tried && !name.trim() ? "Give the address a name: it is who replies are from." : undefined;
  const lockedDefault = first || box?.is_default === true;
  // The address being typed is offered as its own send-from address until it is on the list.
  const typed = cleanMailboxAddress(address);
  const offerOwn = !!typed && !senders.some((x) => x.address === typed);
  const pick = sendFrom === "own" && !offerOwn ? (senders.find((x) => x.address === typed)?.id.toString() ?? "") : sendFrom;
  const picked = senders.find((x) => String(x.id) === pick);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    if (mailboxAddressProblem(address) || !name.trim()) return;
    setBusy(true);
    try {
      const body = {
        address: address.trim(),
        name: name.trim(),
        team_id: team ? Number(team) : null,
        ...(pick === "own" ? { send_from: true } : { send_address_id: pick ? Number(pick) : null }),
        ...(isDefault && !box?.is_default ? { is_default: true } : {}),
      };
      if (box) await sendJson(`/api/helpdesk/admin/mailboxes/${box.id}`, "PATCH", body, "Couldn't save the address.");
      else await sendJson("/api/helpdesk/admin/mailboxes", "POST", body, "Couldn't add the address.");
      onSaved(box ? "Address saved." : "Address added. Forward it to the webhook below.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className={MODAL}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {box ? `Edit ${box.address}` : "Add address"}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      <form onSubmit={submit} noValidate>
        <div className="mt-4 space-y-4">
          <Field label="Address" help="The address people write to, such as billing@yourcompany.com." error={addressError}>
            <TextInput data-autofocus type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="help@yourcompany.com" autoComplete="off" maxLength={MAILBOX_LIMITS.address} />
          </Field>
          <Field label="From name" help="Who replies about tickets on this address are from." error={nameError}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme billing team" maxLength={MAILBOX_LIMITS.name} />
          </Field>
          <Field label="Team" help="Where new tickets on this address start. A team's own email alias, your rules and automations still come first.">
            <Select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">{NO_TEAM}</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Send replies from"
            help={
              <>
                {picked?.name ? `Replies will be from "${picked.name}", the name set on that send-from address. ` : ""}
                Replies go out from the address you pick, through your workspace mail server. Answers always come back to this help address, whatever address the reply was sent
                from. If your mail provider refuses the address, the reply goes out from {workspaceFrom} instead and this page says so.
                {senders.length === 0 && " To offer more addresses here, add them under Send-from addresses on this page."}
              </>
            }
          >
            <Select value={pick} onChange={(e) => setSendFrom(e.target.value)}>
              <option value="">{transportFrom ? `${WORKSPACE_ADDRESS} (${transportFrom})` : WORKSPACE_ADDRESS}</option>
              {senders.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name ? `${x.address} (${x.name})` : x.address}
                </option>
              ))}
              {offerOwn && <option value="own">{typed} (adds it to your send-from addresses)</option>}
            </Select>
          </Field>
          <Toggle
            size="full"
            label="Default address"
            help={
              lockedDefault
                ? first
                  ? "The first address is the default: tickets that didn't come in by email are answered from it, unless their team has an address of its own."
                  : "This is the default. To change it, make another address the default."
                : "Tickets that didn't come in by email are answered from the default, unless their team has an address of its own. Mail to an address that isn't listed counts as mail to it."
            }
            checked={isDefault}
            onChange={setIsDefault}
            disabled={lockedDefault}
          />
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {box ? "Save address" : "Add address"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SendAddressDialog({ sender, onClose, onSaved }: { sender: HdSendAddressView | null; onClose: () => void; onSaved: (message: string) => void }) {
  const titleId = useId();
  const [address, setAddress] = useState(sender?.address ?? "");
  const [name, setName] = useState(sender?.name ?? "");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const addressError = tried ? sendAddressProblem(address) || undefined : undefined;
  const users = sender?.used_by.length ?? 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    if (sendAddressProblem(address)) return;
    setBusy(true);
    try {
      const body = { address: address.trim(), name: name.trim() };
      if (sender) await sendJson(`/api/helpdesk/admin/send-addresses/${sender.id}`, "PATCH", body, "Couldn't save the send-from address.");
      else await sendJson("/api/helpdesk/admin/send-addresses", "POST", body, "Couldn't add the send-from address.");
      onSaved(sender ? "Send-from address saved." : "Send-from address added. Pick it when you edit a help address.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className={MODAL}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {sender ? `Edit ${sender.address}` : "Add send-from address"}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X aria-hidden />
        </button>
      </div>
      <form onSubmit={submit} noValidate>
        <div className="mt-4 space-y-4">
          <Field
            label="Address"
            help="An address your mail provider lets this workspace send from, such as support@yourcompany.com. Verify the sender or its domain at the provider first."
            error={addressError}
          >
            <TextInput data-autofocus type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="support@yourcompany.com" autoComplete="off" maxLength={MAILBOX_LIMITS.address} />
          </Field>
          <Field label="From name (optional)" help="The name on replies sent from this address. Leave it empty and replies carry the name of the help address.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Support" maxLength={MAILBOX_LIMITS.name} />
          </Field>
          {users > 0 && (
            <p className="text-xs text-slate-500">
              {users === 1 ? "1 help address sends" : `${users} help addresses send`} replies from this address and {users === 1 ? "keeps" : "keep"} it after the change.
            </p>
          )}
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {sender ? "Save address" : "Add send-from address"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

"use client";

// Settings → Email: the addresses people write to (1.20.2,
// lib/helpdesk/mailboxes: each with its From name, the team its tickets
// start in and whether replies go out from the address itself), the one
// webhook every address is forwarded to, whether mail from outside the
// workspace may open tickets, and whether a sender's address is trusted
// when the provider reports no SPF/DKIM result (lib/helpdesk/inbound).
// The address list acts at once (add, edit, remove, send test); the two
// "Who can write in" switches save through the page's Save row. Adding the
// first address ticks the setup checklist's Email step.

import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound, Mail, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { CopyButton } from "@/components/CopyButton";
import { Field, FormError, SectionEmpty, Select, TextInput, Toggle } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { useFormatDate } from "@/components/SettingsProvider";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { MAILBOX_LIMITS, mailboxAddressProblem } from "@/lib/helpdesk/mailboxes-shared";
import type { HdMailboxView } from "@/lib/helpdesk/mailboxes-shared";
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
}

const NO_TEAM = "No team (use routing)";
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

  const workspaceFrom = boxes.transport_from || "your workspace's mail address";

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
                    <p className="mt-0.5 text-xs text-slate-500">
                      <span className="sr-only">Replies are from </span>
                      {m.name} · {m.team_name ?? NO_TEAM}
                      {m.tickets > 0 && <> · {m.tickets === 1 ? "1 ticket" : `${m.tickets} tickets`}</>}
                    </p>
                    {m.send_from && m.send_from_error && (
                      <p className="ink-warn mt-1 text-xs" data-testid="hd-mailbox-warning">
                        Your mail provider refused mail from this address{m.send_from_error_at ? ` on ${fmt.dateTime(m.send_from_error_at)}` : ""}: {m.send_from_error} Replies go out from {workspaceFrom} under this name until a test goes through.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="secondary" size="sm" icon={<Send />} busy={testing === m.id} disabled={testing !== null} onClick={() => void sendTest(m)}>
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
            Replies about a ticket go out under the name of the address it came in on, and answers come back to that address. Sending from an address itself only works if your mail
            provider allows {boxes.transport_from ? <>the account behind {boxes.transport_from}</> : "your mail account"} to send as it: use Send test, which goes to your own
            email and shows the provider&apos;s answer.{!boxes.mail_ready && " Outgoing mail isn't set up yet, so nothing is sent."}
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
          workspaceFrom={workspaceFrom}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
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
  workspaceFrom,
  onClose,
  onSaved,
}: {
  box: HdMailboxView | null;
  /** No address is listed yet: this one is the default whatever is chosen. */
  first: boolean;
  teams: { id: number; name: string }[];
  workspaceFrom: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const titleId = useId();
  const [address, setAddress] = useState(box?.address ?? "");
  const [name, setName] = useState(box?.name ?? "");
  const [team, setTeam] = useState(box?.team_id ? String(box.team_id) : "");
  const [sendFrom, setSendFrom] = useState(box?.send_from ?? false);
  const [isDefault, setIsDefault] = useState(box?.is_default ?? first);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const addressError = tried ? mailboxAddressProblem(address) || undefined : undefined;
  const nameError = tried && !name.trim() ? "Give the address a name: it is who replies are from." : undefined;
  const lockedDefault = first || box?.is_default === true;

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
        send_from: sendFrom,
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
          <Toggle
            size="full"
            label="Send replies from this address"
            help={`Off: replies go out from ${workspaceFrom} under the name above, and answers still come back to this address. On: they go out from the address itself, which only works if your mail provider allows your mail account to send as it. If the provider refuses, replies fall back to ${workspaceFrom} and this page says so. Use Send test after saving.`}
            checked={sendFrom}
            onChange={setSendFrom}
          />
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

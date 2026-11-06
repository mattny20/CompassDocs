"use client";

// Settings → Email: the inbound address people write to (forwarded to the
// webhook path your mail provider posts to), whether mail from outside the
// workspace may open tickets, whether a sender's address is trusted when the
// provider reports no SPF/DKIM result (lib/helpdesk/inbound), and the name
// replies are sent from. Saving ticks the setup checklist's Email step.

import { useEffect, useState } from "react";
import { KeyRound, Mail } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { CopyButton } from "@/components/CopyButton";
import { Field, TextInput, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdSettings } from "@/lib/helpdesk/types";
import { getJson, sendJson } from "../api";
import { useCan } from "../me";

type PublicSettings = Omit<HdSettings, "inbound_secret"> & { inbound_enabled: boolean; trust_unverified_senders: boolean };

export function EmailSettings() {
  const can = useCan();
  const [s, setS] = useState<PublicSettings | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(s && { a: s.inbound_address, o: s.outside_senders, n: s.email_from_name, t: s.trust_unverified_senders });
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ settings: PublicSettings; inbound_path: string }>("/api/helpdesk/admin/settings", "Couldn't load the email settings.")
      .then((d) => {
        setS(d.settings);
        setPath(d.inbound_path || "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !s) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!s) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  const url = path ? `${typeof window === "undefined" ? "" : window.location.origin}${path}` : "";
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
        {
          inbound_address: s.inbound_address.trim(),
          outside_senders: s.outside_senders,
          trust_unverified_senders: s.trust_unverified_senders === true,
          email_from_name: s.email_from_name.trim(),
          ...tick,
          ...extra,
        },
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

  return (
    <PageContainer>
      <PageHeader icon={<Mail />} title="Email" subtitle="Forward your help address here, and replies thread back into the ticket." />
      <div className="flex flex-col gap-4">
        <Card title="Inbound address" description="People write to this address; your mail provider forwards each message to the desk.">
          <div className="space-y-4">
            <Field label="Help address" help="Shown to people as where to write, e.g. help@yourcompany.com." size="md">
              <TextInput type="email" value={s.inbound_address} onChange={(e) => set({ inbound_address: e.target.value })} placeholder="help@yourcompany.com" autoComplete="off" />
            </Field>
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
                  Set it as the inbound webhook (inbound parse) in Postmark, SendGrid or Mailgun, or POST JSON with from, subject and text from any other service.
                  Your provider must check SPF and DKIM: Postmark and Mailgun (with spam filtering on) add the results to each message, SendGrid sends them as fields.
                  Other services: add spf, dkim and dmarc results, or forward the receiving server&apos;s Authentication-Results header.
                </p>
              </div>
            ) : (
              <div className="notice-warn flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">Inbound email is off: mail to your help address doesn&apos;t reach the desk yet.</span>
                <Button variant="secondary" size="sm" onClick={rotate} disabled={busy}>
                  Turn on
                </Button>
              </div>
            )}
          </div>
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
        <Card title="Replies">
          <Field label="Sent from (name)" help="Replies go out through your CompassDocs mail settings, under this name." size="md">
            <TextInput value={s.email_from_name} onChange={(e) => set({ email_from_name: e.target.value })} placeholder="IT and HR help desk" maxLength={80} />
          </Field>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={() => void save().then((ok) => ok && toast("ok", "Email settings saved."))} label="Save email settings" />
    </PageContainer>
  );
}

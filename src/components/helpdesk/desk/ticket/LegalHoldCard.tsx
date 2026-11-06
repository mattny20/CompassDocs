"use client";

// The ticket side panel's legal hold (1.19.1, retention and privacy): a
// ticket on hold is never closed, anonymised or deleted by retention or by
// removing an account (lib/helpdesk/retention). Agents who work the ticket
// see the hold when it is on; desk settings.manage turns it on or off.
// Renders nothing for an agent who can't change it while it is off.

import { useEffect, useId, useState } from "react";
import { Lock } from "lucide-react";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Toggle } from "@/components/form";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { getJson, sendJson } from "../api";

interface Hold {
  legal_hold: boolean;
  by_name: string | null;
  at: string | null;
  can_change: boolean;
}

export function LegalHoldCard({ number }: { number: number }) {
  const fmt = useFormatDate();
  const id = useId();
  const [hold, setHold] = useState<Hold | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getJson<Hold>(`/api/helpdesk/tickets/${number}/legal-hold`)
      .then((h) => live && setHold(h))
      .catch(() => live && setHold(null));
    return () => {
      live = false;
    };
  }, [number]);

  if (!hold || (!hold.legal_hold && !hold.can_change)) return null;

  async function set(on: boolean) {
    setBusy(true);
    try {
      const h = await sendJson<Hold>(`/api/helpdesk/tickets/${number}/legal-hold`, "PUT", { on }, "Couldn't change the legal hold.");
      setHold(h);
      toast("ok", on ? `#${number} is on legal hold.` : `#${number} is off legal hold.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const who = hold.legal_hold && hold.by_name ? `Set by ${hold.by_name}${hold.at ? ` on ${fmt.date(hold.at)}` : ""}. ` : "";
  return (
    <section aria-labelledby={`${id}-h`} className={`${CARD_CLASS} p-4 print:hidden`}>
      <h3 id={`${id}-h`} className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
        <Lock className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        Legal hold
      </h3>
      {hold.can_change ? (
        <div className="mt-2">
          <Toggle
            label="Keep this ticket"
            help={`${who}Retention and account removal never close, anonymise or delete it. It can't be deleted, or merged into a ticket that isn't on hold.`}
            checked={hold.legal_hold}
            disabled={busy}
            onChange={(v) => void set(v)}
            size="full"
          />
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          {who}Retention and account removal never close, anonymise or delete this ticket. It can&rsquo;t be deleted, or merged into a ticket that isn&rsquo;t on hold.
        </p>
      )}
    </section>
  );
}

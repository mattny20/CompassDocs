"use client";

// The desk's Duo prompt (1.20.5). When the "when opening the desk" rule's
// time runs out while an agent is working, the next desk request is refused
// with `mfa_required` (desk/api.ts fires DUO_REQUIRED_EVENT). Sending the
// agent to the Duo page would throw away the screen they are on, so this
// offers the approval in a SECOND TAB instead: this page is never navigated,
// the reply box keeps its text (it is also autosaved per ticket in this
// browser), and after approval the agent presses Send again.
//
// Renders nothing until that event arrives.

import { useEffect, useState } from "react";
import { ExternalLink, ShieldAlert, X } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { toast } from "@/components/Toasts";
import { DUO_REQUIRED_EVENT } from "./api";

const STEP = "/login/duo?for=desk";

export function DuoDeskPrompt() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(DUO_REQUIRED_EVENT, show);
    // The second tab says when Duo approved (components/auth/DuoStep).
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel("compass-duo");
      channel.onmessage = (e) => {
        if (e.data !== "approved") return;
        setOpen((was) => {
          if (was) toast("ok", "Confirmed with Duo. Carry on where you left off.");
          return false;
        });
      };
    } catch {
      /* no BroadcastChannel: the agent closes the prompt themselves */
    }
    return () => {
      window.removeEventListener(DUO_REQUIRED_EVENT, show);
      channel?.close();
    };
  }, []);

  if (!open) return null;
  return (
    <div
      role="alert"
      className="notice-warn fixed inset-x-0 top-3 z-50 mx-auto flex w-[min(38rem,calc(100%-2rem))] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm shadow-float print:hidden"
    >
      <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 basis-64">
        <span className="font-semibold">Confirm with Duo to keep working.</span> It opens in a new tab. Nothing you have typed here is lost.
      </p>
      {/* window.open, not a link: a tab this page opened may close itself when Duo is done. */}
      <button type="button" onClick={() => window.open(STEP, "_blank")} className={buttonClass("primary", "sm")}>
        Confirm with Duo
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button type="button" onClick={() => setOpen(false)} className={iconButtonClass("quiet", "sm")} aria-label="Dismiss" data-tt="Dismiss">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

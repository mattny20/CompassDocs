"use client";

// The Duo step's one action (1.20.5, app/login/duo): "Continue with Duo"
// asks the server to start the step and goes where it says, which is Duo's
// prompt (or straight on, when nothing is owed any more). The failure
// states are a line above the button; Duo being down has its own heading
// (the page's) and the button reads "Try again". Sign out is always there,
// so nobody is stuck on this page.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { FormError } from "@/components/form";
import { SignOutLink } from "@/components/SignOutLink";
import { Spinner } from "@/components/Spinner";
import { IdentifierRow } from "./IdentifierRow";

export type DuoStepProblem = "denied" | "expired" | "unreachable" | "refused" | "limited";

const PROBLEM_TEXT: Record<Exclude<DuoStepProblem, "unreachable">, string> = {
  denied: "Duo didn't approve that. Try again. If you didn't expect a Duo request, tell an administrator.",
  expired: "That took too long, or it was started in another window. Try again.",
  limited: "Too many tries. Wait a few minutes, then try again.",
  refused: "Duo isn't set up correctly on this workspace, so it can't confirm it's you. An administrator needs to check the Duo details in Settings.",
};

export function DuoStep({
  next,
  account,
  fromDesk = false,
  deskScope = false,
  problem = null,
  done = false,
}: {
  /** Where to go afterwards (already reduced to a same-app path by the page). */
  next: string;
  /** Who is signed in, as Duo will be asked about them. */
  account: string;
  /** Opened from inside the desk, in a second tab: finish on "you can close this tab". */
  fromDesk?: boolean;
  /** Asked for the desk rule on the way to a page outside /desk; kept across a retry. */
  deskScope?: boolean;
  problem?: DuoStepProblem | null;
  /** Nothing is owed any more (the second tab, after approval). */
  done?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The tab that asked (the desk) can carry on: tell it, then offer to close this one.
    if (done) {
      try {
        const ch = new BroadcastChannel("compass-duo");
        ch.postMessage("approved");
        ch.close();
      } catch {
        /* no BroadcastChannel: the desk notices on its next request */
      }
    } else {
      button.current?.focus();
    }
  }, [done]);

  if (done) {
    return (
      <div className="space-y-4">
        <p className="notice-ok flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden /> Confirmed with Duo.
        </p>
        <button type="button" onClick={() => window.close()} className={buttonClass("primary", "lg", "w-full")}>
          Close this tab
        </button>
        <p className="text-sm text-slate-500">
          If the tab stays open, close it yourself, or{" "}
          <a href={next} className="link">
            open the desk here
          </a>
          .
        </p>
      </div>
    );
  }

  const here = (code: DuoStepProblem) => {
    const q = new URLSearchParams({ e: code });
    if (fromDesk) q.set("for", "desk");
    else {
      if (deskScope) q.set("scope", "desk");
      if (next !== "/") q.set("next", next);
    }
    return `/login/duo?${q}`;
  };

  async function start() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/duo/start", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(fromDesk ? { for: "desk" } : { next }),
      });
      const data = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string; code?: string };
      if (res.ok && typeof data.redirect === "string") {
        // Duo's prompt, or the page they wanted. A full navigation either way.
        window.location.assign(data.redirect);
        return;
      }
      if (res.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (data.code === "duo_unreachable" || data.code === "duo_refused") {
        router.replace(here(data.code === "duo_refused" ? "refused" : "unreachable"));
        router.refresh();
      } else {
        setError(data.error || "Couldn't start the Duo check. Try again.");
      }
    } catch {
      setError("Couldn't reach CompassDocs. Check your connection, then try again.");
    }
    setBusy(false);
  }

  const retry = problem !== null;
  return (
    <div className="space-y-4" aria-busy={busy || undefined}>
      <IdentifierRow label="Signed in as" value={account} action={<SignOutLink className={buttonClass("ghost", "sm")} />} />
      {problem && problem !== "unreachable" && (
        <p role="alert" className="notice-error rounded-lg border px-3 py-2 text-sm">
          {PROBLEM_TEXT[problem]}
        </p>
      )}
      <FormError>{error}</FormError>
      <button
        ref={button}
        type="button"
        onClick={start}
        aria-disabled={busy || undefined}
        className={buttonClass("primary", "lg", "w-full")}
      >
        {busy ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
        {retry ? "Try again" : "Continue with Duo"}
      </button>
      <p className="text-sm text-slate-500">
        {problem === "unreachable"
          ? "If this keeps happening, tell an administrator. They can see it in the audit log."
          : "You'll go to Duo to approve the request, usually a push on your phone. Then you come straight back."}
      </p>
    </div>
  );
}

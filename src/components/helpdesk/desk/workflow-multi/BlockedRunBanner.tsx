"use client";

// The coordinator's banner on a request whose workflow stopped (run state
// "blocked": a team marked its task Can't be done and the step says stop).
// It names the team, the step and their reason, and offers the three ways
// on: **Retry step** (the task goes back to the team), **Skip and carry
// on** (with an optional note) and **Cancel workflow** (danger). Each asks
// first, toasts the result and the server's own refusal.
// POST /api/helpdesk/runs/[id]/{retry-step|skip-step|cancel}.

import { useState } from "react";
import { Ban, OctagonPause, RotateCcw, SkipForward } from "lucide-react";
import { Button } from "@/components/Button";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import type { HdTicketDetail } from "@/lib/helpdesk/types";
import { sendJson } from "../api";
import type { HdProgressStepB, HdWorkflowProgressB } from "./contract";
import { flatSteps } from "./TaskOutcome";

export function blockedStepOf(wf: HdWorkflowProgressB | null | undefined): HdProgressStepB | null {
  if (!wf || wf.state !== "blocked") return null;
  const all = flatSteps(wf.steps);
  return (wf.blocked ? all.find((s) => s.key === wf.blocked?.step_key) : null) ?? all.find((s) => s.state === "failed") ?? null;
}

export function BlockedRunBanner({ detail, onChanged }: { detail: HdTicketDetail; onChanged?: () => void }) {
  const wf = detail.workflow as HdWorkflowProgressB | null;
  const [busy, setBusy] = useState<"" | "retry" | "skip" | "cancel">("");
  if (!wf || wf.state !== "blocked") return null;
  const step = blockedStepOf(wf);
  const team = step?.team_name ?? "A team";
  const title = wf.blocked?.title || step?.title || "a step";
  const note = wf.blocked?.note || step?.note || "";
  const at = wf.blocked?.at ?? step?.acted_at ?? step?.finished_at ?? null;
  const who = step?.actor ?? step?.assignee_name ?? null;
  const can = detail.can_work;

  async function act(kind: "retry" | "skip" | "cancel", body: Record<string, unknown>, ok: string) {
    setBusy(kind);
    try {
      const path = kind === "retry" ? "retry-step" : kind === "skip" ? "skip-step" : "cancel";
      await sendJson(`/api/helpdesk/runs/${wf!.run_id}/${path}`, "POST", body, "Couldn't change the workflow.");
      toast("ok", ok);
      onChanged?.();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function retry() {
    const yes = await confirmDialog({
      title: `Retry "${title}"?`,
      body: `The task goes back to ${team}'s queue and the workflow waits for it again.`,
      confirmLabel: "Retry step",
    });
    if (yes === true) await act("retry", { step_key: wf!.blocked?.step_key ?? step?.key }, `"${title}" is back with ${team}.`);
  }

  async function skip() {
    const note = await promptDialog({
      title: `Skip "${title}" and carry on?`,
      body: "The workflow moves on to its next step as if this one were done. Steps that check its hand-off fields see them empty.",
      label: "Note (optional)",
      type: "textarea",
      required: false,
      confirmLabel: "Skip and carry on",
    });
    if (note === null) return;
    await act("skip", { step_key: wf!.blocked?.step_key ?? step?.key, note: note.trim() || undefined }, "Skipped. The workflow carries on.");
  }

  async function cancel() {
    const yes = await confirmDialog({
      title: "Cancel the workflow?",
      body: "No more steps run and its open tasks are closed. The request stays open with you to finish by hand. This cannot be undone.",
      confirmLabel: "Cancel workflow",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (yes === true) await act("cancel", {}, "Workflow cancelled. The request is yours to finish.");
  }

  return (
    <section aria-labelledby="blocked-h" className="notice-warn rounded-lg border px-4 py-3 text-sm">
      <div className="flex items-start gap-2.5">
        <OctagonPause className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="blocked-h" className="font-semibold">
            Workflow stopped: {team} can&apos;t do &ldquo;{title}&rdquo;
          </h3>
          {note && <p className="mt-0.5 whitespace-pre-line">Reason: {note}</p>}
          <p className="mt-0.5 text-xs opacity-90">
            {who}
            {at && (
              <>
                {who ? " · " : ""}
                <RelativeTime value={at} />
              </>
            )}
            {can ? "" : `${who || at ? " · " : ""}The request's team decides what happens next.`}
          </p>
        </div>
      </div>
      {can && (
        <div className="mt-3 flex flex-wrap gap-2 sm:pl-6.5">
          <Button variant="secondary" size="sm" icon={<RotateCcw />} busy={busy === "retry"} disabled={!!busy} onClick={retry}>
            Retry step
          </Button>
          <Button variant="secondary" size="sm" icon={<SkipForward />} busy={busy === "skip"} disabled={!!busy} onClick={skip}>
            Skip and carry on
          </Button>
          <Button variant="danger" size="sm" icon={<Ban />} busy={busy === "cancel"} disabled={!!busy} onClick={cancel}>
            Cancel workflow
          </Button>
        </div>
      )}
    </section>
  );
}

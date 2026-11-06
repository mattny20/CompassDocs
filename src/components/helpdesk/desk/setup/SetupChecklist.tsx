"use client";

// /desk/setup: the five-step checklist a helpdesk manager sees first.
// Every step starts with sensible defaults, so the desk can open after
// step one; "Use the starter set" writes the lot (IT, HR and Facilities,
// the starter reply targets, six request types with their workflows, three
// macros and an example rule) in one go. State from GET
// /api/helpdesk/admin/setup; the starter set is POST …/setup/starter.

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Clock, LifeBuoy, ListChecks, Mail, Sparkles, Star, Users } from "lucide-react";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { EnterpriseBadge } from "@/components/Chip";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { getJson, sendJson } from "../api";
import { useDeskCounts } from "../counts";

interface StepState {
  key: "teams" | "hours" | "email" | "forms" | "csat";
  done: boolean;
  summary: string;
}

interface Checklist {
  steps: StepState[];
  done: number;
  total: number;
  setup_complete: boolean;
}

const STEPS: Record<StepState["key"], { icon: React.ReactNode; title: string; body: string; href: string }> = {
  teams: { icon: <Users className="h-4 w-4" aria-hidden />, title: "Teams", body: "IT, HR and Facilities, with who answers for each.", href: "/desk/settings/teams" },
  hours: {
    icon: <Clock className="h-4 w-4" aria-hidden />,
    title: "Hours and reply targets",
    body: "Mon to Fri, 9:00 to 17:30. Urgent: reply in 1 hour. Everything else: reply in 4 business hours, resolve in 2 days.",
    href: "/desk/settings/sla",
  },
  email: { icon: <Mail className="h-4 w-4" aria-hidden />, title: "Email", body: "Forward your help address here, and replies thread back into the ticket.", href: "/desk/settings/email" },
  forms: {
    icon: <ListChecks className="h-4 w-4" aria-hidden />,
    title: "Request form",
    body: "The categories people pick in Get help, and any extra questions per category.",
    href: "/desk/settings/request-types",
  },
  csat: { icon: <Star className="h-4 w-4" aria-hidden />, title: "Satisfaction", body: "Ask one question when a ticket is solved: how did we do?", href: "/desk/settings/csat" },
};

export function SetupChecklist() {
  const [c, setC] = useState<Checklist | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { refresh: refreshCounts } = useDeskCounts();

  const load = useCallback(() => {
    getJson<Checklist>("/api/helpdesk/admin/setup", "Couldn't load the checklist.")
      .then((d) => {
        setC(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);

  async function starter() {
    const ok = await confirmDialog({
      title: "Use the starter set?",
      body: "Adds the teams IT, HR and Facilities, the starter reply targets, six request types with their workflows (new laptop, access to a space, report a problem, new starter, ask HR, facilities repair), three macros and an example rule. Anything you already have is kept; you can change or remove every part later.",
      confirmLabel: "Use the starter set",
    });
    if (ok !== true) return;
    setBusy(true);
    try {
      const d = await sendJson<{ checklist?: Checklist }>("/api/helpdesk/admin/setup/starter", "POST", {}, "Couldn't add the starter set.");
      toast("ok", "Starter set added. Add your agents to the teams next.");
      if (d.checklist) setC(d.checklist);
      else load();
      refreshCounts();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pct = c ? Math.round((c.done / Math.max(1, c.total)) * 100) : 0;
  const teamsDone = c?.steps.find((s) => s.key === "teams")?.done;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <PageContainer>
        <PageHeader
          icon={<LifeBuoy />}
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              Set up your helpdesk <EnterpriseBadge />
            </span>
          }
          subtitle="Five short steps. Every one starts with sensible defaults, so you can open the doors after step one and come back later."
        />
        {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
        {!c && !error && <LoadingRow className="py-10" />}
        {c && (
          <>
            <section aria-label="Progress" className={`${CARD_CLASS} p-5`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-base font-semibold text-slate-900">
                  {c.done} of {c.total} done
                </p>
                <div className="flex flex-wrap gap-2">
                  {!teamsDone && (
                    <Button variant="secondary" icon={<Sparkles />} busy={busy} onClick={starter}>
                      Use the starter set
                    </Button>
                  )}
                  <Button href="/desk" variant={teamsDone ? "primary" : "secondary"}>
                    Open the helpdesk
                  </Button>
                </div>
              </div>
              <div
                role="progressbar"
                aria-label="Setup progress"
                aria-valuemin={0}
                aria-valuemax={c.total}
                aria-valuenow={c.done}
                className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"
              >
                <span className="block h-full rounded-full bg-compass-500 transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              {!teamsDone && (
                <p className="mt-3 text-sm text-slate-600">New here? The starter set fills in all five steps with an IT, HR and Facilities desk you can adjust.</p>
              )}
            </section>
            <ol className={`${CARD_CLASS} mt-4 divide-y divide-slate-100`}>
              {c.steps.map((s, i) => {
                const meta = STEPS[s.key];
                if (!meta) return null;
                return (
                  <li key={s.key} className="flex flex-wrap items-start gap-4 p-5 sm:flex-nowrap">
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                        s.done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-compass-50 text-compass-700"
                      }`}
                      aria-hidden
                    >
                      {s.done ? <Check className="h-4.5 w-4.5" /> : meta.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-base font-semibold text-slate-900">
                        {i + 1}. {meta.title}
                        <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                      </h2>
                      <p className="mt-0.5 text-sm text-slate-600">{meta.body}</p>
                      {s.done && s.summary && (
                        <p className="mt-1.5 inline-flex items-center gap-1 text-xs ink-ok">
                          <Check className="h-3.5 w-3.5" aria-hidden /> {s.summary}
                        </p>
                      )}
                    </div>
                    <Button href={meta.href} variant="secondary" aria-label={`${s.done ? "Edit" : "Set up"} ${meta.title.toLowerCase()}`}>
                      {s.done ? "Edit" : "Set up"}
                    </Button>
                  </li>
                );
              })}
            </ol>
            <p className="mt-4 flex items-start gap-2 text-sm text-slate-500">
              <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              Your CompassDocs spaces are the knowledge base: Get help suggests their documents before anyone opens a ticket.
            </p>
          </>
        )}
      </PageContainer>
    </div>
  );
}

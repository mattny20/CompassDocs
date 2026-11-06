"use client";

// Settings → Satisfaction: one question when a request is solved ("How did
// we do?", five faces from Very bad to Great, an optional comment). On or
// off for the whole helpdesk; a workflow's Finish step can still skip it.
// Saving ticks the setup checklist's Satisfaction step.

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { Card } from "@/components/Card";
import { Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdSettings } from "@/lib/helpdesk/types";
import { useCan } from "../me";
import { getJson, sendJson } from "../api";

const SCALE = ["Very bad", "Bad", "Okay", "Good", "Great"];

export function CsatSettings() {
  const can = useCan();
  const [s, setS] = useState<Pick<HdSettings, "csat_enabled" | "setup_steps_done"> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const snap = JSON.stringify(s?.csat_enabled ?? null);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  useEffect(() => {
    getJson<{ settings: HdSettings }>("/api/helpdesk/admin/settings", "Couldn't load the survey settings.")
      .then((d) => setS({ csat_enabled: d.settings.csat_enabled, setup_steps_done: d.settings.setup_steps_done ?? [] }))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error && !s) return <PageContainer><p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p></PageContainer>;
  if (!s) return <PageContainer><LoadingRow className="py-10" /></PageContainer>;

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      await sendJson(
        "/api/helpdesk/admin/settings",
        "PATCH",
        {
          csat_enabled: s.csat_enabled,
          // The checklist needs settings.manage: only when it changes and the person may (csat.manage alone can save).
          ...(!s.setup_steps_done.includes("csat") && can("settings.manage") ? { setup_steps_done: [...s.setup_steps_done, "csat"] } : {}),
        },
        "Couldn't save the survey settings."
      );
      markClean(snap);
      toast("ok", s.csat_enabled ? "The survey is on." : "The survey is off.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader icon={<Star />} title="Satisfaction" subtitle="Ask one question when a ticket is solved: how did we do?" />
      <div className="flex flex-col gap-4">
        <Card title="The survey">
          <Toggle
            label="Ask after every solved request"
            help="The requester gets it by email and on the request in Get help. Answers show in Reports."
            checked={s.csat_enabled}
            onChange={(v) => {
              markDirty();
              setS({ ...s, csat_enabled: v });
            }}
          />
        </Card>
        <Card title="What people see" description="A preview. The answer is one click; the comment is optional.">
          <div className="rounded-lg border border-slate-200 bg-canvas p-4" aria-hidden>
            <p className="text-sm font-semibold text-slate-900">How did we do with #1047?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SCALE.map((l, i) => (
                <span key={l} className={`rounded-lg border px-3 py-1.5 text-sm ${i === 4 ? "border-compass-300 bg-compass-50 text-compass-700" : "border-slate-200 bg-surface text-slate-700"}`}>
                  {l}
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Anything we could do better? (optional)</p>
          </div>
        </Card>
      </div>
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save survey settings" />
    </PageContainer>
  );
}

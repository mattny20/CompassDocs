"use client";

// Desk settings → Retention and privacy (1.19.1, mock-up #6): how long
// helpdesk tickets are kept (solved tickets close after N days; closed
// tickets are anonymised or deleted after a period; both rules are off
// until an admin turns them on, so nothing happens on upgrade), what happens to a
// removed account's tickets, and whether a person's data export includes
// their requests. "Preview the next run" is the dry run with the choices on
// the page, saved or not; See the list opens its tickets. Choosing Delete
// asks before it is saved. lib/helpdesk/retention does the work, nightly.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Shield, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { confirmDialog } from "@/components/Dialog";
import { SectionEmpty, TextInput, Toggle } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Segmented } from "@/components/Segmented";
import { useFormatDate } from "@/components/SettingsProvider";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { HD_RETENTION_LIMITS, planSentence } from "@/lib/helpdesk/retention-shared";
import type { HdRetentionItem, HdRetentionPlan, HdRetentionSettings } from "@/lib/helpdesk/retention-shared";
import { getJson, sendJson } from "../api";

const WHAT: Record<HdRetentionItem["what"], { label: string; tone: "neutral" | "warn" | "error" }> = {
  close: { label: "Closes", tone: "neutral" },
  anonymise: { label: "Anonymised", tone: "warn" },
  delete: { label: "Deleted", tone: "error" },
};

/** A number field's text while typing ("" allowed), and the number it holds when valid. */
function intOf(text: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

export function RetentionSettings() {
  const fmt = useFormatDate();
  const [saved, setSaved] = useState<HdRetentionSettings | null>(null);
  const [s, setS] = useState<HdRetentionSettings | null>(null);
  const [daysText, setDaysText] = useState("");
  const [keepText, setKeepText] = useState("");
  const [plan, setPlan] = useState<HdRetentionPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const snap = JSON.stringify(s);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);
  const daysId = useId();
  const keepId = useId();

  useEffect(() => {
    getJson<{ settings: HdRetentionSettings }>("/api/helpdesk/admin/retention", "Couldn't load the retention settings.")
      .then((d) => {
        setSaved(d.settings);
        setS(d.settings);
        setDaysText(String(d.settings.auto_close_days));
        setKeepText(String(d.settings.keep_amount));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // The preview follows the page's choices (debounced), saved or not.
  const seq = useRef(0);
  const preview = useCallback(async (settings: HdRetentionSettings) => {
    const mine = ++seq.current;
    try {
      const d = await sendJson<{ plan: HdRetentionPlan }>("/api/helpdesk/admin/retention/preview", "POST", { settings }, "Couldn't preview the next run.");
      if (mine === seq.current) {
        setPlan(d.plan);
        setPlanError("");
      }
    } catch (e) {
      if (mine === seq.current) setPlanError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(() => void preview(s), 350);
    return () => clearTimeout(t);
  }, [s, preview]);

  if (error && !s) {
    return (
      <PageContainer>
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </PageContainer>
    );
  }
  if (!s || !saved) {
    return (
      <PageContainer>
        <LoadingRow className="py-10" />
      </PageContainer>
    );
  }

  const change = (patch: Partial<HdRetentionSettings>) => {
    markDirty();
    setS({ ...s, ...patch });
  };
  const lim = HD_RETENTION_LIMITS[s.keep_unit];
  // A rule that is off hides its fields, so they can't block a save.
  const daysError = s.auto_close_enabled && intOf(daysText, HD_RETENTION_LIMITS.autoCloseDays.min, HD_RETENTION_LIMITS.autoCloseDays.max) === null;
  const keepError = s.retention_enabled && intOf(keepText, lim.min, lim.max) === null;

  async function save() {
    if (!s || daysError || keepError) return;
    const purgeWasOn = !!saved?.retention_enabled;
    if (s.retention_enabled && s.action === "delete" && (!purgeWasOn || saved?.action !== "delete")) {
      const n = plan?.counts.delete ?? 0;
      const ok = await confirmDialog({
        title: "Move old tickets to the recycle bin?",
        body: `Closed tickets older than ${s.keep_amount} ${s.keep_unit} go to the recycle bin, where they can be restored for 30 days. After that they're deleted for good, files included, and reports stop counting them.${n ? ` Tonight that is ${n.toLocaleString("en-GB")} ${n === 1 ? "ticket" : "tickets"}.` : ""} Tickets on legal hold are kept.`,
        confirmLabel: "Move to the recycle bin",
        danger: true,
      });
      if (ok !== true) return;
    } else if (s.retention_enabled && !purgeWasOn && (plan?.counts.anonymise ?? 0) > 0) {
      const n = plan?.counts.anonymise ?? 0;
      const ok = await confirmDialog({
        title: "Anonymise old tickets?",
        body: `Closed tickets older than ${s.keep_amount} ${s.keep_unit} lose their subject, names, emails, message text and files. Reports still count them. The next run anonymises ${n.toLocaleString("en-GB")} ${n === 1 ? "ticket" : "tickets"}, and this can't be undone. Tickets on legal hold are kept.`,
        confirmLabel: "Anonymise old tickets",
        danger: true,
      });
      if (ok !== true) return;
    }
    setBusy(true);
    try {
      const d = await sendJson<{ settings: HdRetentionSettings }>("/api/helpdesk/admin/retention", "PUT", s, "Couldn't save the retention settings.");
      setSaved(d.settings);
      setS(d.settings);
      markClean(JSON.stringify(d.settings));
      toast("ok", "Retention settings saved.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Shield />}
        title="Retention and privacy"
        subtitle="How long helpdesk tickets are kept, and what happens to a person's tickets when their account goes."
      />
      <div className="flex flex-col gap-4">
        <Card>
          <div className="space-y-5">
            <div>
              <Toggle
                label="Close solved tickets automatically"
                help="Off until you turn it on. A reply after a ticket closes opens a follow-up."
                checked={s.auto_close_enabled}
                onChange={(v) => change({ auto_close_enabled: v })}
                size="full"
              />
              {s.auto_close_enabled && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-700">
                  <label htmlFor={daysId}>After</label>
                  <TextInput
                    id={daysId}
                    inputMode="numeric"
                    className="w-20"
                    value={daysText}
                    aria-invalid={daysError || undefined}
                    aria-describedby={`${daysId}-help`}
                    onChange={(e) => {
                      setDaysText(e.target.value);
                      const n = intOf(e.target.value, HD_RETENTION_LIMITS.autoCloseDays.min, HD_RETENTION_LIMITS.autoCloseDays.max);
                      if (n !== null) change({ auto_close_days: n });
                      else markDirty();
                    }}
                  />
                  <span id={`${daysId}-help`}>days without a reply.</span>
                </div>
              )}
              {daysError && (
                <p className="mt-1 text-xs text-red-600">
                  {HD_RETENTION_LIMITS.autoCloseDays.min} to {HD_RETENTION_LIMITS.autoCloseDays.max} days.
                </p>
              )}
            </div>
            <div>
              <Toggle
                label="Anonymise or delete old closed tickets"
                help="Off until you turn it on: closed tickets are kept for good."
                checked={s.retention_enabled}
                onChange={(v) => change({ retention_enabled: v })}
                size="full"
              />
              {s.retention_enabled && (
                <>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-slate-700">
                    <label htmlFor={keepId}>Keep closed tickets for</label>
                    <TextInput
                      id={keepId}
                      inputMode="numeric"
                      className="w-20"
                      value={keepText}
                      aria-invalid={keepError || undefined}
                      onChange={(e) => {
                        setKeepText(e.target.value);
                        const n = intOf(e.target.value, lim.min, lim.max);
                        if (n !== null) change({ keep_amount: n });
                        else markDirty();
                      }}
                    />
                    <Segmented
                      label="Months or years"
                      value={s.keep_unit}
                      onChange={(v) => {
                        const l = HD_RETENTION_LIMITS[v];
                        const n = Math.min(l.max, Math.max(l.min, s.keep_amount));
                        setKeepText(String(n));
                        change({ keep_unit: v, keep_amount: n });
                      }}
                      options={[
                        { value: "months", label: "months" },
                        { value: "years", label: "years" },
                      ]}
                    />
                    <span>then</span>
                    <Segmented
                      label="Then"
                      value={s.action}
                      onChange={(v) => change({ action: v })}
                      options={[
                        { value: "anonymise", label: "Anonymise" },
                        { value: "delete", label: "Delete" },
                      ]}
                    />
                  </div>
                  {keepError && (
                    <p className="mt-1 text-xs text-red-600">
                      {lim.min} to {lim.max} {s.keep_unit}.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-slate-500">
                    Anonymise keeps the ticket for reports but removes names, emails, message text and attachments. Delete moves it to the recycle bin, and it's deleted for good 30 days later. Tickets on legal hold are never touched.
                  </p>
                </>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <div className="space-y-4">
            <Toggle
              label="When an account is removed"
              help="Anonymise that person's tickets as requester and CC. Their agent replies keep the agent's name."
              checked={s.anonymise_on_account_removal}
              onChange={(v) => change({ anonymise_on_account_removal: v })}
              size="full"
            />
            <Toggle
              label="Include tickets in a person's data export"
              help="Their requests with the public conversation, and their own messages on requests they were copied on. Never internal notes."
              checked={s.include_in_export}
              onChange={(v) => change({ include_in_export: v })}
              size="full"
            />
          </div>
        </Card>

        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">Preview the next run</h2>
              <p className="mt-0.5 text-sm text-slate-600" aria-live="polite" data-testid="retention-preview">
                {planError ? planError : plan ? planSentence(plan) : "Working it out…"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">
              {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
              <Button variant="secondary" onClick={() => setListOpen(true)} disabled={!plan}>
                See the list
              </Button>
              <Button onClick={save} busy={busy} disabled={!dirty || daysError || keepError}>
                Save
              </Button>
            </div>
          </div>
        </Card>
      </div>
      {plan && <PlanList open={listOpen} onClose={() => setListOpen(false)} plan={plan} dateOf={fmt.date} />}
    </PageContainer>
  );
}

function PlanList({ open, onClose, plan, dateOf }: { open: boolean; onClose: () => void; plan: HdRetentionPlan; dateOf: (iso: string | null) => string }) {
  const titleId = useId();
  const total = plan.counts.close + plan.counts.anonymise + plan.counts.delete;
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-surface shadow-modal">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            The next run
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">{planSentence(plan)}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
          <X aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {plan.items.length === 0 ? (
          <SectionEmpty className="py-6">Nothing is due tonight.</SectionEmpty>
        ) : (
          <ul aria-label="Tickets in the next run" className="divide-y divide-slate-100">
            {plan.items.map((t) => (
              <li key={`${t.what}-${t.id}`} className="flex items-center gap-3 py-2.5">
                <span className="w-14 shrink-0 text-sm tabular-nums text-slate-500">#{t.number}</span>
                <span className="min-w-0 flex-1">
                  <a href={`/desk/tickets/${t.number}`} className="block truncate text-sm font-medium text-slate-900 hover:underline">
                    {t.subject}
                  </a>
                  <span className="block text-xs text-slate-500">
                    {t.team_name ?? "No team"} · {t.what === "close" ? "solved" : "closed"} {dateOf(t.since)}
                  </span>
                </span>
                <Chip tone={WHAT[t.what].tone} size="sm">
                  {WHAT[t.what].label}
                </Chip>
              </li>
            ))}
          </ul>
        )}
        {plan.items.length > 0 && plan.items.length < total && (
          <p className="mt-2 text-xs text-slate-500">Showing the first {plan.items.length.toLocaleString("en-GB")} of {total.toLocaleString("en-GB")}, oldest first.</p>
        )}
      </div>
    </Modal>
  );
}

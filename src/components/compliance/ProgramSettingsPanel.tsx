"use client";

// Program settings (E4, 1.10.1): the defaults every policy inherits, as
// cards with one Save row. Each card ships with the item that reads its
// values, so the page never shows a control nothing honours. Editing (the
// per-document default A5 applies when a document is first set to required)
// and Confirmation statement (the sentence on the end-of-article card) from
// 1.10.1; Re-confirmation (the interval a policy receives when first set to
// required, G1) from 1.12.0; Deadlines and reminders (the seven numbers of
// the policy -> space -> workspace -> built-in cascade, E1/E2) from 1.13.0.
// Compliance report (the scheduled summary email: on or off, weekly or
// monthly, to whom; F2) from 1.14.0, saved through its own route inside
// the page's one Save. Add any further card above the SaveRow.

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/Card";
import { CARD_TITLE_TEXT, Eyebrow } from "@/components/Heading";
import { Field, Select, TextInput, Textarea, Toggle, rangeError } from "@/components/form";
import { Segmented } from "@/components/Segmented";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { SaveRow } from "@/components/SaveRow";
import { buttonClass } from "@/components/Button";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { RECERT_OPTIONS } from "@/lib/ack-recert";
import { BUILT_IN, DUE_FIELDS, DUE_NUMBER_KEYS, DUE_RANGES } from "@/lib/ack-due";
import type { DueNumberKey } from "@/lib/ack-due";
import { EDIT_DEFAULT_OPTIONS } from "./copy";
import type { AckReportSettings, ComplianceSettings, EditDefault } from "@/lib/compliance-settings";

// The three "when the text of a policy changes" options live in ./copy with
// the rest of the shared compliance copy (A5's popover and the portal chip
// read them there); re-exported so an existing import from here still
// resolves.
export { EDIT_DEFAULT_OPTIONS };

/** The server enforces the same limit (STATEMENT_MAX in lib/compliance-settings,
 *  a server-only module, so the number is repeated here). */
const STATEMENT_MAX = 300;

function statementError(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "Enter a confirmation statement.";
  if (t.length > STATEMENT_MAX) return `Keep the statement under ${STATEMENT_MAX} characters.`;
  return undefined;
}

/** The seven deadline numbers as typed: "" = unset (the built-in applies). */
type DueForm = Record<DueNumberKey, string>;

interface FormState {
  edit_default: EditDefault;
  keep_reason_required: boolean;
  /** null = never: a policy switched on receives no cycle. */
  recert_months: number | null;
  /** "Group leads see policy standing" (F4, 1.14.0): the team view and the digest's Policies section for leads. */
  leads_see_policies: boolean;
  statement: string;
  due: DueForm;
  /** The scheduled report (F2, 1.14.0); saved through its own route. */
  report: AckReportSettings;
}

function fromSettings(s: ComplianceSettings): FormState {
  return {
    edit_default: s.ack_defaults.edit_default,
    keep_reason_required: s.ack_defaults.keep_reason_required,
    recert_months: s.ack_defaults.recert_months,
    leads_see_policies: s.ack_defaults.leads_see_policies,
    statement: s.compliance_statement_default,
    due: Object.fromEntries(DUE_NUMBER_KEYS.map((k) => [k, s.ack_defaults[k] == null ? "" : String(s.ack_defaults[k])])) as DueForm,
    report: { enabled: s.ack_report.enabled, cadence: s.ack_report.cadence, recipients: [...s.ack_report.recipients] },
  };
}

/** A blank field keeps the built-in; anything typed must be a whole number in the key's range. */
function dueError(key: DueNumberKey, value: string): string | undefined {
  return value === "" ? undefined : rangeError(value, DUE_RANGES[key].min, DUE_RANGES[key].max);
}

/** The Select's option value for an interval: "" for never, else the months. */
const recertValue = (months: number | null) => (months === null ? "" : String(months));

/** The server enforces the same cap (REPORT_RECIPIENTS_MAX in lib/compliance-settings, a server-only module). */
const REPORT_RECIPIENTS_MAX = 50;

/** The two cadences of the report (F2): the labels items/F2.md names. */
const REPORT_CADENCE: { value: AckReportSettings["cadence"]; label: string }[] = [
  { value: "weekly", label: "Weekly (Monday)" },
  { value: "monthly", label: "Monthly (with the snapshot)" },
];

/** A report that is on needs someone to go to; the route caps the list and refuses an inactive account. */
function reportError(r: AckReportSettings): string | undefined {
  if (r.recipients.length > REPORT_RECIPIENTS_MAX) return `Choose up to ${REPORT_RECIPIENTS_MAX} recipients.`;
  if (r.enabled && r.recipients.length === 0) return "Choose at least one recipient, or turn the report off.";
  return undefined;
}

export function ProgramSettingsPanel({ initial }: { initial: ComplianceSettings }) {
  const [s, setS] = useState<FormState>(() => fromSettings(initial));
  const [saving, setSaving] = useState(false);
  const fmt = useFormatDate();

  // The report block (F2): the picker's options (active accounts, the list
  // the @mention picker reads), when the report last went out, and the last
  // saved values so an unchanged block is not re-sent. Loads, not edits, so
  // nothing here marks the page dirty.
  const [userOpts, setUserOpts] = useState<PickerOption[]>([]);
  const [lastSent, setLastSent] = useState<{ at: string; period: string } | null>(null);
  const [reportBaseline, setReportBaseline] = useState<AckReportSettings>(initial.ack_report);
  useEffect(() => {
    void fetch("/api/users/mentionable")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.users) throw new Error();
        setUserOpts(
          (d.users as { id: number; name: string; username: string }[]).map((u) => ({
            id: u.id,
            label: u.name || u.username,
            sublabel: u.username,
          }))
        );
      })
      .catch(() => toast("error", "Couldn't load people for the report's recipients."));
    void fetch("/api/admin/compliance/report")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.last_sent) setLastSent(d.last_sent);
      })
      .catch(() => {});
  }, []);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);

  /** User edits only (STYLEGUIDE §Forms: never from a mount effect). */
  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    markDirty();
    setS((prev) => ({ ...prev, [key]: value }));
  }

  function setDue(key: DueNumberKey, value: string) {
    markDirty();
    setS((prev) => ({ ...prev, due: { ...prev.due, [key]: value } }));
  }

  function setReport(patch: Partial<AckReportSettings>) {
    markDirty();
    setS((prev) => ({ ...prev, report: { ...prev.report, ...patch } }));
  }

  const errors = {
    statement: statementError(s.statement),
    due: Object.fromEntries(DUE_NUMBER_KEYS.map((k) => [k, dueError(k, s.due[k])])) as Record<DueNumberKey, string | undefined>,
    report: reportError(s.report),
  };
  const invalid = Boolean(errors.statement) || Object.values(errors.due).some(Boolean) || Boolean(errors.report);
  const option = EDIT_DEFAULT_OPTIONS.find((o) => o.value === s.edit_default) ?? EDIT_DEFAULT_OPTIONS[0];

  async function save() {
    if (invalid) {
      toast("error", "Fix the highlighted fields first.");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/admin/compliance/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ack_defaults: {
          edit_default: s.edit_default,
          keep_reason_required: s.keep_reason_required,
          recert_months: s.recert_months,
          // Always sent (F4): the first save of ack_defaults creates the stored
          // row, and a row without this key reads as off on the next read.
          leads_see_policies: s.leads_see_policies,
          // Blank = null = the built-in; the server refuses anything out of range.
          ...Object.fromEntries(DUE_NUMBER_KEYS.map((k) => [k, s.due[k] === "" ? null : Number(s.due[k])])),
        },
        compliance_statement_default: s.statement,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSaving(false);
      toast("error", data?.error || "Could not save program settings.");
      return;
    }
    // The report block (F2) saves through its own route, which also refuses
    // a recipient that is not an active account. A refusal is toasted and
    // leaves the page dirty: the defaults above are already saved, and a
    // retry re-sends them unchanged.
    const report = await saveReport();
    setSaving(false);
    if (!report) return;
    markClean();
    if (data?.settings) setS(fromSettings({ ...data.settings, ack_report: report }));
    toast("ok", "Program settings saved.");
  }

  /** PUT /api/admin/compliance/report when the block changed: the saved values, or null when refused (toasted). */
  async function saveReport(): Promise<AckReportSettings | null> {
    if (JSON.stringify(s.report) === JSON.stringify(reportBaseline)) return reportBaseline;
    const res = await fetch("/api/admin/compliance/report", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s.report),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save the report settings.");
      return null;
    }
    const next: AckReportSettings = data?.settings ?? s.report;
    setReportBaseline(next);
    return next;
  }

  return (
    <div className="space-y-6">
      <Card
        title="Editing"
        description="How a policy treats a change to its text. A policy receives this when it is first set to require read confirmation and can change it in the Read confirmation popover on the document."
      >
        <Field label="When the text of a policy changes" help={option.help} size="lg">
          <Select value={s.edit_default} onChange={(e) => set("edit_default", e.target.value as EditDefault)}>
            {EDIT_DEFAULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Toggle
          className="mt-4"
          label="Require a reason for editorial fixes too"
          help="A material change always needs a change note. With this on, an editorial fix needs one as well, so a kept edit is never silent on the record."
          checked={s.keep_reason_required}
          onChange={(next) => set("keep_reason_required", next)}
        />
      </Card>

      <Card
        title="Confirmation statement"
        description="The sentence a reader agrees to on the card at the end of every policy."
      >
        <Field
          label="Default statement"
          help="One sentence, in the reader's voice. A policy can carry its own statement on the Settings tab of its Read confirmation page."
          error={errors.statement}
        >
          <Textarea
            value={s.statement}
            onChange={(e) => set("statement", e.target.value)}
            rows={2}
            spellCheck
          />
        </Field>
        <StatementPreview statement={s.statement} />
      </Card>

      <Card
        title="Re-confirmation"
        description="How often everyone is asked to read and confirm a policy again, whether or not its text changed."
      >
        <Field
          label="Re-confirm every"
          help="Applied when a policy is first set to require confirmation. Each policy can change it on its Settings tab."
          size="sm"
        >
          <Select
            value={recertValue(s.recert_months)}
            onChange={(e) => set("recert_months", e.target.value === "" ? null : Number(e.target.value))}
          >
            {RECERT_OPTIONS.map((o) => (
              <option key={recertValue(o.months)} value={recertValue(o.months)}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Card
        title="Deadlines and reminders"
        description="How long people have to confirm a policy, and when CompassDocs reminds them and escalates. A space can set its own under its Policy defaults, and a policy its own on its Settings tab. A blank field keeps the built-in."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {DUE_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              help={s.due[f.key] === "" ? `Built-in: ${BUILT_IN[f.key]}` : f.help}
              error={errors.due[f.key]}
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={DUE_RANGES[f.key].min}
                max={DUE_RANGES[f.key].max}
                step={1}
                placeholder={String(BUILT_IN[f.key])}
                value={s.due[f.key]}
                onChange={(e) => setDue(f.key, e.target.value)}
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card
        title="Compliance report"
        description="A summary of the programme by email: compliance, overdue people, escalations, the lowest policies and the deadlines ahead. The monthly report carries the monthly snapshot's SHA-256."
      >
        <Toggle
          label="Send the compliance report"
          help="Weekly on Monday, or monthly with the snapshot, to the people below. Nothing goes out while email is not set up."
          checked={s.report.enabled}
          onChange={(next) => setReport({ enabled: next })}
        />
        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-slate-500">Cadence</span>
          <Segmented label="Cadence" options={REPORT_CADENCE} value={s.report.cadence} onChange={(next) => setReport({ cadence: next })} />
        </div>
        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium text-slate-500">Recipients</span>
          <EntityPicker
            options={userOpts}
            value={s.report.recipients}
            onChange={(ids) => setReport({ recipients: ids })}
            label="Recipients"
            placeholder="Search people…"
          />
          {errors.report ? (
            <span role="alert" className="mt-1 block text-xs text-red-600">
              {errors.report}
            </span>
          ) : (
            <span className="mt-1 block text-xs text-slate-500">
              Up to {REPORT_RECIPIENTS_MAX} people with an active account.
              {lastSent ? ` Last sent ${fmt.date(lastSent.at)} (${lastSent.period}).` : " Not sent yet."}
            </span>
          )}
        </div>
      </Card>

      {/* Team leads (F4, 1.14.0): its own card rather than a toggle inside
          Editing (which is about text changes): the one setting that opens
          the lead view and the digest's Policies section. The leads
          themselves are named on the Overview's Team leads block. */}
      <Card
        title="Team leads"
        description="Leads of a group are named on the Overview's Team leads block; the same leads see their group's training when that is licensed."
      >
        <Toggle
          label="Group leads see policy standing"
          help="Leads of a group see where its members stand on policies in spaces they can read, and get the weekly summary."
          checked={s.leads_see_policies}
          onChange={(next) => set("leads_see_policies", next)}
        />
      </Card>

      <SaveRow dirty={dirty} busy={saving} onSave={save} disabled={invalid} />
    </div>
  );
}

/**
 * The end-of-article card as readers will see it (AckCard's recipe,
 * STYLEGUIDE §Sections and cards), redrawn as the statement is typed. A
 * picture of the card, not the card: nothing in it is a control, and it is
 * hidden from assistive technology because the textarea above already
 * carries the same words.
 */
function StatementPreview({ statement }: { statement: string }) {
  const fmt = useFormatDate();
  const text = statement.replace(/\s+/g, " ").trim();
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <Eyebrow>Preview</Eyebrow>
      <div aria-hidden className="rounded-xl border border-slate-200 bg-canvas p-6 sm:p-8">
        <div className="flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-compass-50 text-compass-600">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <p className={`mt-3 ${CARD_TITLE_TEXT}`}>Confirm you&apos;ve read this document</p>
          <p className={`mt-2 max-w-md text-sm ${text ? "text-slate-600" : "text-slate-500 italic"}`}>
            {text || "The statement goes here."}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Version 12 · published {fmt.date("2026-03-03T09:00:00Z")} by Dana Whitfield
          </p>
          <span className={buttonClass("primary", "lg", "mt-5 w-full sm:w-auto")}>
            <ShieldCheck className="h-4 w-4" /> I&apos;ve read and understood this
          </span>
        </div>
      </div>
    </div>
  );
}

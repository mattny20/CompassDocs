"use client";

// Program settings (E4, 1.10.1): the defaults every policy inherits, as
// cards with one Save row. Each card ships with the item that reads its
// values, so the page never shows a control nothing honours. In this
// release: Editing (the per-document default A5 applies when a document is
// first set to required) and Confirmation statement (the sentence on the
// end-of-article card). Deadlines and Reminders arrive with E1/E2, the
// typed-signature toggle with C2, Annual re-confirmation with G1 and
// Evidence with F2/C5; add each as another <Card> above the SaveRow.

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/Card";
import { CARD_TITLE_TEXT, Eyebrow } from "@/components/Heading";
import { Field, Select, Textarea, Toggle } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { buttonClass } from "@/components/Button";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { ComplianceSettings, EditDefault } from "@/lib/compliance-settings";

/** The three answers to "when the text of a policy changes", in the order
 *  the Select shows them. A5's popover shows the same labels and suffixes
 *  the one equal to the workspace value with "(workspace default)". */
export const EDIT_DEFAULT_OPTIONS: { value: EditDefault; label: string; help: string }[] = [
  {
    value: "ask",
    label: "Ask the editor each time (recommended)",
    help: "Every text save opens the question: editorial fix, or material change. The editor decides and the record keeps the choice.",
  },
  {
    value: "material",
    label: "Ask only when a change looks material",
    help: "Good for procedures that change often: typo-sized edits pass quietly and are recorded; anything that looks material still asks.",
  },
  {
    value: "reset",
    label: "Always ask everyone to re-confirm",
    help: "Good for signed-off policies: every text change asks everyone to re-confirm, and the change note is required.",
  },
];

/** The server enforces the same limit (STATEMENT_MAX in lib/compliance-settings,
 *  a server-only module, so the number is repeated here). */
const STATEMENT_MAX = 300;

function statementError(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "Enter a confirmation statement.";
  if (t.length > STATEMENT_MAX) return `Keep the statement under ${STATEMENT_MAX} characters.`;
  return undefined;
}

interface FormState {
  edit_default: EditDefault;
  keep_reason_required: boolean;
  statement: string;
}

function fromSettings(s: ComplianceSettings): FormState {
  return {
    edit_default: s.ack_defaults.edit_default,
    keep_reason_required: s.ack_defaults.keep_reason_required,
    statement: s.compliance_statement_default,
  };
}

export function ProgramSettingsPanel({ initial }: { initial: ComplianceSettings }) {
  const [s, setS] = useState<FormState>(() => fromSettings(initial));
  const [saving, setSaving] = useState(false);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);

  /** User edits only (STYLEGUIDE §Forms: never from a mount effect). */
  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    markDirty();
    setS((prev) => ({ ...prev, [key]: value }));
  }

  const errors = { statement: statementError(s.statement) };
  const invalid = Object.values(errors).some(Boolean);
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
        ack_defaults: { edit_default: s.edit_default, keep_reason_required: s.keep_reason_required },
        compliance_statement_default: s.statement,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      toast("error", data?.error || "Could not save program settings.");
      return;
    }
    markClean();
    if (data?.settings) setS(fromSettings(data.settings));
    toast("ok", "Program settings saved.");
  }

  return (
    <div className="space-y-6">
      <Card
        title="Editing"
        description="How a policy treats a change to its text. A policy receives this when it is first set to require read confirmation and can change it on its own settings page."
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
          help="One sentence, in the reader's voice. A policy can carry its own statement once per-policy settings arrive."
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

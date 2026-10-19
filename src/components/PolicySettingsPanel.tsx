"use client";

// The Settings tab of a policy's Read confirmation page (C2, 1.12.0): the
// per-policy settings as stacked cards with one Save row, the page's only
// primary action. Every card is its own component taking the shared form
// model { s, set, errors }, so the cards wave 2 adds ("Re-confirmation",
// "Lifecycle") are a component each and a few lines here. In this release:
// Confirmation statement (the sentence on the card at the end of the
// document, and the typed-signature switch).
//
// The save PATCHes /api/documents/[id]/ack-settings with what the form
// holds; the route answers what the document now holds, which becomes the
// clean state (STYLEGUIDE §Forms: markClean before applying the response).

import { useState } from "react";
import { Card } from "@/components/Card";
import { Field, Textarea, Toggle } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";

/** The server enforces the same limit (the ack-settings route). */
export const STATEMENT_MAX = 500;

/** What the page hands the panel: the document's own values and the workspace default. */
export interface PolicySettingsInitial {
  /** The policy's own statement; null = the workspace default. */
  statement: string | null;
  /** The workspace default (Program settings), shown as the placeholder. */
  statement_default: string;
  signature: boolean;
}

/** The form as edited; '' for the statement means "use the default". */
export interface PolicySettingsForm {
  statement: string;
  signature: boolean;
}

/** The model every card takes: the values, one setter, the field errors. */
export interface PolicySettingsModel {
  s: PolicySettingsForm;
  set: <K extends keyof PolicySettingsForm>(key: K, value: PolicySettingsForm[K]) => void;
  errors: Partial<Record<keyof PolicySettingsForm, string | undefined>>;
}

function fromInitial(i: PolicySettingsInitial): PolicySettingsForm {
  return { statement: i.statement ?? "", signature: i.signature };
}

function statementError(text: string): string | undefined {
  return text.trim().length > STATEMENT_MAX ? `Keep the statement under ${STATEMENT_MAX} characters.` : undefined;
}

export function PolicySettingsPanel({
  doc,
  initial,
}: {
  doc: { id: number; title: string };
  initial: PolicySettingsInitial;
}) {
  const [s, setS] = useState<PolicySettingsForm>(() => fromInitial(initial));
  const [saving, setSaving] = useState(false);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);

  /** User edits only (STYLEGUIDE §Forms: never from a mount effect). */
  function set<K extends keyof PolicySettingsForm>(key: K, value: PolicySettingsForm[K]) {
    markDirty();
    setS((prev) => ({ ...prev, [key]: value }));
  }

  const errors: PolicySettingsModel["errors"] = { statement: statementError(s.statement) };
  const invalid = Object.values(errors).some(Boolean);
  const model: PolicySettingsModel = { s, set, errors };

  async function save() {
    if (invalid) {
      toast("error", "Fix the highlighted fields first.");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/documents/${doc.id}/ack-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statement: s.statement.trim(), signature: s.signature }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<PolicySettingsInitial> & { error?: string };
    setSaving(false);
    if (!res.ok) {
      toast("error", data?.error || "Could not save the settings.");
      return;
    }
    markClean();
    setS(fromInitial({ statement: data.statement ?? null, statement_default: initial.statement_default, signature: data.signature ?? s.signature }));
    toast("ok", "Settings saved.");
  }

  return (
    <div className="space-y-6">
      <StatementCard model={model} statementDefault={initial.statement_default} />
      <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save settings" disabled={invalid} />
    </div>
  );
}

/**
 * The confirmation statement and the typed signature. The statement is
 * rendered on the card through MarkdownView, so a clause may carry
 * emphasis or a link; blank means the workspace default, which the
 * placeholder shows.
 */
export function StatementCard({ model, statementDefault }: { model: PolicySettingsModel; statementDefault: string }) {
  const { s, set, errors } = model;
  return (
    <Card
      title="Confirmation statement"
      description="What a reader agrees to on the card at the end of this document, and how they confirm it. Leave the statement blank to use the workspace default from Program settings."
    >
      <Field
        label="Confirmation statement"
        help='Shown above the confirm button and stored with every confirmation. Legal teams may add a clause such as "and that I will comply with it".'
        error={errors.statement}
      >
        <Textarea
          rows={3}
          maxLength={STATEMENT_MAX}
          placeholder={statementDefault}
          value={s.statement}
          onChange={(e) => set("statement", e.target.value)}
          spellCheck
        />
      </Field>
      <Toggle
        className="mt-4"
        label="Require typed signature"
        help="The reader types their full name; local accounts also re-enter their password. SSO accounts are identified by their sign-in session."
        checked={s.signature}
        onChange={(next) => set("signature", next)}
      />
    </Card>
  );
}

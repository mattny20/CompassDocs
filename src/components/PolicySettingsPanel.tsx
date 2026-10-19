"use client";

// The Settings tab of a policy's Read confirmation page (C2, 1.12.0): the
// per-policy settings as stacked cards with one Save row, the page's only
// primary action. Every card is its own component taking the shared form
// model { s, set, errors }: Confirmation statement (C2: the sentence on
// the card at the end of the document, and the typed-signature switch),
// Re-confirmation (G1: how often everyone is asked again, the next date and
// the effective date) and Lifecycle (G3: the policy that replaces this one,
// Retire policy… and Un-retire).
//
// The save PATCHes /api/documents/[id]/ack-settings with the fields that
// changed since the last clean state (so a stored next date that has
// already passed is never re-judged by a save that did not touch it); the
// route answers what the document now holds, which becomes the clean state
// (STYLEGUIDE §Forms: markClean before applying the response). Retire and
// Un-retire are not form fields: they POST at once, ask first (formDialog /
// confirmDialog, awaited before any busy state) and refresh the route, and
// the card follows the server's answer.

import { useState } from "react";
import { Archive, ArchiveRestore, X } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { confirmDialog, formDialog } from "@/components/Dialog";
import { EntityPicker, type PickerOption } from "@/components/EntityPicker";
import { Field, Select, Textarea, TextInput, Toggle } from "@/components/form";
import { SaveRow } from "@/components/SaveRow";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { Tooltip } from "@/components/Tooltip";
import { RECONFIRM_REASON_TOO_SHORT } from "@/components/ReconfirmButton";
import { RECERT_OPTIONS, addMonths, nextRecertDate, recertOptionLabel } from "@/lib/ack-recert";
import { useAction } from "@/lib/use-action";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";

/** The server enforces the same limit (the ack-settings route). */
export const STATEMENT_MAX = 500;

/** The Lifecycle card's two actions (STYLEGUIDE §Vocabulary: the same words on the portal row). */
export const RETIRE_LABEL = "Retire policy…";
export const UNRETIRE_LABEL = "Un-retire";
/** The inline validation line of the next-date field; the route answers the same rule with 400. */
export const NEXT_DATE_PAST = "The next re-confirmation date cannot be in the past.";

/** What the page hands the panel: the document's own values and what the cards need to show them. */
export interface PolicySettingsInitial {
  /** The policy's own statement; null = the workspace default. */
  statement: string | null;
  /** The workspace default (Program settings), shown as the placeholder. */
  statement_default: string;
  signature: boolean;
  /** Re-confirmation (G1): the interval in months (null = never), the stored next date (ISO) and the effective date ('YYYY-MM-DD'). */
  recert_months: number | null;
  next_recert_at: string | null;
  effective_at: string | null;
  /** The marker (ack_revision_at): the first cycle is dated from it, and the warn line compares it with the interval. */
  marker: string;
  /** The workspace's interval (Program settings): its option is suffixed "(workspace default)". */
  recert_default: number | null;
  /** Lifecycle (G3): the replacement, with its title for the chip (null once it is in the Trash), and the picker's options. */
  superseded_by: number | null;
  superseded_by_title: string | null;
  replacements: PickerOption[];
  /** documents.ack_required: only a policy that asks for confirmation can be retired. */
  required: boolean;
  /** The retirement, when the policy is retired. */
  retired: { at: string; by: string; reason: string } | null;
  /** The standing for the Retire question: "42 of 50 people have confirmed version 12". */
  summary: { current: number; eligible: number; rev: number | null };
  /** The signed-in person, named on the card right after they retire the policy. */
  viewerName: string;
}

/** The form as edited; '' for the statement means "use the default", '' for a date means none. */
export interface PolicySettingsForm {
  statement: string;
  signature: boolean;
  recert_months: number | null;
  /** 'YYYY-MM-DD' (the UTC day of the stored instant), or ''. */
  next_recert_at: string;
  /** 'YYYY-MM-DD', or ''. */
  effective_at: string;
  superseded_by: number | null;
}

/** The model every card takes: the values, one setter, the field errors. */
export interface PolicySettingsModel {
  s: PolicySettingsForm;
  set: <K extends keyof PolicySettingsForm>(key: K, value: PolicySettingsForm[K]) => void;
  errors: Partial<Record<keyof PolicySettingsForm, string | undefined>>;
}

/** What GET and PATCH /ack-settings answer (the parts the form reads back). */
interface SettingsAnswer {
  statement: string | null;
  signature: boolean;
  recert_months: number | null;
  next_recert_at: string | null;
  effective_at: string | null;
  marker: string | null;
  recert_default: number | null;
  superseded_by: number | null;
  superseded_by_title: string | null;
}

/** 'YYYY-MM-DD' of an instant, in UTC: what a date-only input holds and what the route reads it as. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole calendar months from one moment to another, at least one ("People last re-confirmed 18 months ago"). */
function monthsBetween(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(1, months);
}

function fromInitial(i: PolicySettingsInitial): PolicySettingsForm {
  return {
    statement: i.statement ?? "",
    signature: i.signature,
    recert_months: i.recert_months,
    next_recert_at: i.next_recert_at ? ymd(new Date(i.next_recert_at)) : "",
    effective_at: i.effective_at ?? "",
    superseded_by: i.superseded_by,
  };
}

function statementError(text: string): string | undefined {
  return text.trim().length > STATEMENT_MAX ? `Keep the statement under ${STATEMENT_MAX} characters.` : undefined;
}

/** The same rule validateRecertPatch applies: today counts, yesterday does not. */
function nextDateError(s: PolicySettingsForm): string | undefined {
  if (s.recert_months === null || !s.next_recert_at) return undefined;
  return s.next_recert_at < ymd(new Date()) ? NEXT_DATE_PAST : undefined;
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
  // What the server holds: the clean form is derived from it, the marker
  // and the workspace default come from it, and the Lifecycle card reads
  // the retirement from it. A refresh (after Retire or Un-retire) hands the
  // panel a new `initial`, and the server's values win; the person's
  // unsaved edits are kept.
  const [server, setServer] = useState(initial);
  const [seen, setSeen] = useState(initial);

  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify(s));
  useLeaveGuard(dirty, hasUnsavedChanges);

  if (initial !== seen) {
    setSeen(initial);
    setServer(initial);
    if (!dirty) setS(fromInitial(initial));
  }

  /** User edits only (STYLEGUIDE §Forms: never from a mount effect). */
  function set<K extends keyof PolicySettingsForm>(key: K, value: PolicySettingsForm[K]) {
    markDirty();
    setS((prev) => ({ ...prev, [key]: value }));
  }

  const errors: PolicySettingsModel["errors"] = {
    statement: statementError(s.statement),
    next_recert_at: nextDateError(s),
  };
  const invalid = Object.values(errors).some(Boolean);
  const model: PolicySettingsModel = { s, set, errors };

  async function save() {
    if (invalid) {
      toast("error", "Fix the highlighted fields first.");
      return;
    }
    // Only what moved since the last clean state goes to the server.
    const saved = fromInitial(server);
    const body: Record<string, unknown> = {};
    if (s.statement.trim() !== saved.statement) body.statement = s.statement.trim();
    if (s.signature !== saved.signature) body.signature = s.signature;
    if (s.recert_months !== saved.recert_months) body.recert_months = s.recert_months;
    // The next date rides along only with an interval: the server clears it
    // on Never, and a date on a policy with no interval is not stored.
    if (s.recert_months !== null && s.next_recert_at !== saved.next_recert_at) body.next_recert_at = s.next_recert_at || null;
    if (s.effective_at !== saved.effective_at) body.effective_at = s.effective_at || null;
    if (s.superseded_by !== saved.superseded_by) body.superseded_by = s.superseded_by;
    if (Object.keys(body).length === 0) {
      markClean();
      setS(saved);
      toast("ok", "Settings saved.");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/documents/${doc.id}/ack-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<SettingsAnswer> & { error?: string };
    setSaving(false);
    if (!res.ok) {
      toast("error", data?.error || "Could not save the settings.");
      return;
    }
    markClean();
    const next: PolicySettingsInitial = {
      ...server,
      statement: data.statement ?? null,
      signature: data.signature ?? s.signature,
      recert_months: data.recert_months ?? null,
      next_recert_at: data.next_recert_at ?? null,
      effective_at: data.effective_at ?? null,
      marker: data.marker ?? server.marker,
      recert_default: data.recert_default === undefined ? server.recert_default : data.recert_default,
      superseded_by: data.superseded_by ?? null,
      superseded_by_title: data.superseded_by_title ?? null,
    };
    setServer(next);
    setS(fromInitial(next));
    toast("ok", "Settings saved.");
  }

  return (
    <div className="space-y-6">
      <StatementCard model={model} statementDefault={server.statement_default} />
      <ReconfirmationCard
        model={model}
        marker={server.marker}
        workspaceDefault={server.recert_default}
        stored={{ recert_months: server.recert_months, next_recert_at: fromInitial(server).next_recert_at }}
      />
      <LifecycleCard
        model={model}
        doc={doc}
        server={server}
        onRetired={(retired) => setServer((prev) => ({ ...prev, retired }))}
        onResumed={(standing) => {
          // Un-retire clears the replacement on the server (a policy that is
          // live again is not replaced by anything): the form follows.
          setServer((prev) => ({
            ...prev,
            retired: null,
            superseded_by: null,
            superseded_by_title: null,
            summary: { ...prev.summary, ...standing },
          }));
          setS((prev) => ({ ...prev, superseded_by: null }));
        }}
      />
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

/**
 * Periodic re-confirmation (G1): the interval, the next date and the
 * effective date. Changing the interval prefills the next date the way the
 * server would schedule it (marker + N months, or 14 days out when that is
 * already past); the date can then be moved, and the warn line says when
 * the first cycle was pushed out because people last re-confirmed longer
 * ago than the interval.
 */
export function ReconfirmationCard({
  model,
  marker,
  workspaceDefault,
  stored,
}: {
  model: PolicySettingsModel;
  /** ack_revision_at: when everyone was last asked. */
  marker: string;
  /** Program settings' interval; null for Never. */
  workspaceDefault: number | null;
  /** What the server holds, so choosing the stored interval again brings its stored date back. */
  stored: { recert_months: number | null; next_recert_at: string };
}) {
  const { s, set, errors } = model;
  const fmt = useFormatDate();
  const markerDate = new Date(marker);
  const now = new Date();
  const options = RECERT_OPTIONS.some((o) => o.months === s.recert_months)
    ? RECERT_OPTIONS
    : [...RECERT_OPTIONS, { months: s.recert_months, label: recertOptionLabel(s.recert_months) }];

  function onInterval(value: string) {
    const months = value === "" ? null : Number(value);
    set("recert_months", months);
    // Never: no date. The stored interval again: its stored date comes back.
    // Another interval: the date the server would schedule from the marker.
    if (months === null) set("next_recert_at", "");
    else if (months === stored.recert_months) set("next_recert_at", stored.next_recert_at);
    else set("next_recert_at", ymd(nextRecertDate(markerDate, months, now)));
  }

  // The first cycle was pushed out: the marker plus the interval is already
  // in the past, so the server dates it 14 days from now instead.
  const pushedOut = s.recert_months !== null && addMonths(markerDate, s.recert_months).getTime() <= now.getTime();
  const firstCycle = s.next_recert_at || (s.recert_months !== null ? ymd(nextRecertDate(markerDate, s.recert_months, now)) : "");

  return (
    <Card
      title="Re-confirmation"
      description="How often everyone is asked to read and confirm this policy again, whether or not its text changed, and the day it came into force."
    >
      <Field
        label="Re-confirm every"
        help="Everyone who can see this document is asked to read and confirm it again at this interval. Applied from the workspace default when confirmation was first required."
        size="sm"
      >
        <Select value={s.recert_months === null ? "" : String(s.recert_months)} onChange={(e) => onInterval(e.target.value)}>
          {options.map((o) => (
            <option key={o.months ?? "never"} value={o.months === null ? "" : String(o.months)}>
              {o.months === workspaceDefault ? `${o.label} (workspace default)` : o.label}
            </option>
          ))}
        </Select>
      </Field>

      {s.recert_months !== null && (
        <Field
          label="Next re-confirmation"
          help="Everyone is asked again on this date. A material change restarts the interval."
          error={errors.next_recert_at}
          size="sm"
          className="mt-4"
        >
          <TextInput
            type="date"
            min={ymd(now)}
            value={s.next_recert_at}
            onChange={(e) => set("next_recert_at", e.target.value)}
          />
        </Field>
      )}

      {pushedOut && s.recert_months !== null && (
        // The hint that must be amber (STYLEGUIDE §Notices: ink-warn, never a bare text-amber).
        <p className="mt-2 text-xs ink-warn">
          People last re-confirmed {monthsBetween(markerDate, now)} months ago. The first cycle is scheduled for{" "}
          {fmt.date(firstCycle)}: change the date, or use Ask everyone to re-confirm now.
        </p>
      )}

      <Field
        label="Effective date"
        help="The day this policy came into force. Set to the day confirmation was first required unless you change it."
        size="sm"
        className="mt-4"
      >
        <TextInput type="date" value={s.effective_at} onChange={(e) => set("effective_at", e.target.value)} />
      </Field>
    </Card>
  );
}

/**
 * The lifecycle (G3): the policy that replaces this one, saved through the
 * page's Save row like any field, and the end of its life. Retire asks
 * first with the standing and a required reason, then POSTs and refreshes;
 * a retired policy shows when, by whom and why, with Un-retire, which asks
 * and then resumes. Both are secondary buttons: the Save row is the page's
 * one primary action.
 */
export function LifecycleCard({
  model,
  doc,
  server,
  onRetired,
  onResumed,
}: {
  model: PolicySettingsModel;
  doc: { id: number; title: string };
  server: PolicySettingsInitial;
  onRetired: (retired: NonNullable<PolicySettingsInitial["retired"]>) => void;
  onResumed: (standing: { current: number; eligible: number }) => void;
}) {
  const { s, set } = model;
  const fmt = useFormatDate();
  const { run, isBusy, busy } = useAction();
  const { retired, summary, replacements, required } = server;
  // The chip's title: the server's (the stored replacement, even one the
  // picker does not offer), else the picked option's.
  const chosenTitle =
    s.superseded_by === null
      ? null
      : (s.superseded_by === server.superseded_by ? server.superseded_by_title : null) ??
        replacements.find((o) => o.id === s.superseded_by)?.label ??
        `Document #${s.superseded_by}`;

  async function retire() {
    const version = summary.rev ? `version ${summary.rev}` : "the current version";
    // Awaited before any busy state (STYLEGUIDE §Overlays): Cancel leaves
    // the control idle.
    const values = await formDialog({
      title: `Retire "${doc.title}"?`,
      body: `${summary.current} of ${summary.eligible} people have confirmed ${version}. Retiring stops asking anyone to confirm, keeps every confirmation on record, and lists the policy under Retired in Compliance. The document itself stays as it is; unpublish it separately if people should no longer read it.`,
      fields: [
        {
          key: "reason",
          label: "Why is this policy being retired?",
          type: "textarea",
          required: true,
          help: "Shown on the compliance record and in exports",
          validate: (v) => (v.trim().length < 10 ? RECONFIRM_REASON_TOO_SHORT : undefined),
        },
      ],
      confirmLabel: "Retire policy",
    });
    if (!values) return;
    const reason = values.reason.trim();
    const box: { result?: { acked?: number; required?: number } } = {};
    const ok = await run(
      "retire",
      async () => {
        const res = await fetch(`/api/documents/${doc.id}/ack/retire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as typeof box.result;
        return res;
      },
      { fallback: "Couldn't retire the policy." }
    );
    if (!ok) return;
    onRetired({ at: new Date().toISOString(), by: server.viewerName, reason });
    const acked = Number(box.result?.acked ?? summary.current);
    const total = Number(box.result?.required ?? summary.eligible);
    toast("ok", `Policy retired. ${acked} of ${total} confirmations stay on record.`);
  }

  async function unretire() {
    const ok = await confirmDialog({
      title: `Resume read confirmation for "${doc.title}"?`,
      body: "Confirmations made before it was retired stay on record. If the text changed while it was retired, people whose confirmation is older than the current version are asked again.",
      confirmLabel: "Resume",
    });
    if (!ok) return;
    const box: { result?: { current?: number; eligible?: number } } = {};
    const done = await run(
      "unretire",
      async () => {
        const res = await fetch(`/api/documents/${doc.id}/ack/unretire`, { method: "POST" });
        if (res.ok) box.result = (await res.clone().json().catch(() => ({}))) as typeof box.result;
        return res;
      },
      { fallback: "Couldn't resume the policy." }
    );
    if (!done) return;
    const standing = { current: Number(box.result?.current ?? 0), eligible: Number(box.result?.eligible ?? summary.eligible) };
    onResumed(standing);
    // The re-ask (A7) is the header's "Ask everyone to re-confirm…", back
    // on the refreshed page; the toast carries no action of its own.
    toast("ok", `Policy resumed: ${standing.current} of ${standing.eligible} confirmations still current`);
  }

  const retireButton = (
    <Button
      variant="secondary"
      size="sm"
      icon={<Archive />}
      onClick={() => void retire()}
      disabled={!required || busy}
      busy={isBusy("retire")}
    >
      {RETIRE_LABEL}
    </Button>
  );

  return (
    <Card
      title="Lifecycle"
      description="The policy that replaces this one, and retiring it when it no longer applies. Retiring keeps every confirmation on record and lists the policy under Retired in Compliance."
    >
      {/* A composite picker keeps its own markup (STYLEGUIDE §Forms): the
          Field's label and help recipes around the picker, or the chosen
          document as a chip with its clear button (the portal's Request
          card). Not a Field: a label element around the chip would hand a
          click on the words to the clear button. */}
      <div className="max-w-md">
        <span className="mb-1 block text-xs font-medium text-slate-500">Replaced by</span>
        {s.superseded_by !== null ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-compass-200 bg-compass-50 px-3 py-1.5 text-sm font-medium text-compass-800">
            {chosenTitle}
            <button
              type="button"
              onClick={() => set("superseded_by", null)}
              data-tt="Clear replacement"
              aria-label="Clear replacement"
              className="opacity-60 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <EntityPicker
            options={replacements}
            onPick={(id) => set("superseded_by", id)}
            label="Replaced by"
            placeholder="Find a published document…"
            emptyText="No published documents match."
            maxVisible={10}
          />
        )}
        <span className="mt-1 block text-xs text-slate-500">
          Readers of a retired policy are pointed to its replacement. Saved with the settings.
        </span>
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4">
        {retired ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">
                Retired {fmt.date(retired.at)}
                {retired.by ? ` by ${retired.by}` : ""}
              </p>
              {retired.reason && <p className="mt-0.5 text-sm text-slate-600">{retired.reason}</p>}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<ArchiveRestore />}
              onClick={() => void unretire()}
              disabled={busy}
              busy={isBusy("unretire")}
            >
              {UNRETIRE_LABEL}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-slate-600">
              Stop asking anyone to confirm this policy. Its record, its versions and the document itself stay as they are.
            </p>
            {/* A disabled button does not fire hover reliably: the wrapper
                carries the tooltip (components/Tooltip is the recipe). */}
            {required ? retireButton : <Tooltip label="This document doesn't ask for a read confirmation.">{retireButton}</Tooltip>}
          </div>
        )}
      </div>
    </Card>
  );
}

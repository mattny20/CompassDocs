"use client";

// Test run: a dry run of the builder's working copy (POST
// /api/helpdesk/admin/workflows/[id]/test-run). Optional sample answers
// for the form's date fields, and "decline at" to see the decline path;
// the result is each step in order with what it would do, when it would
// start, and anything to fix. Nothing is created or sent.
//
// Multi-team (agent M): sample answers for every question the form asks
// (a choice offers its options), a requester picker (whose manager
// approves, whose directory entry the Only if and the routes read), and
// the result shows skipped steps with the reason and the team a routed
// task would go to.

import { useEffect, useId, useState } from "react";
import { CalendarDays, CircleAlert, CircleSlash, FlaskConical, Signpost, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, FormError, Select, TextInput } from "@/components/form";
import { Chip } from "@/components/Chip";
import { EntityPicker } from "@/components/EntityPicker";
import { EYEBROW_TEXT } from "@/components/Heading";
import { useFormatDate } from "@/components/SettingsProvider";
import type { HdFormAnswers, HdFormField, HdWorkflowDefinition } from "@/lib/helpdesk/types";
import type { SimulatedStep, SimulationResult } from "@/lib/helpdesk/workflows";
import { itemOf, sendJson } from "../api";
import { personOption, usePeople } from "../people";
import type { SimulatedStepExtras } from "../workflow-multi/contract";

type SimStep = SimulatedStep & SimulatedStepExtras;

/** Questions a sample answer can be given for (a person picker is left to the requester). */
const sampleable = (f: HdFormField) => f.type !== "user";

function toAnswers(form: HdFormField[], raw: Record<string, string>): HdFormAnswers {
  const out: HdFormAnswers = {};
  for (const f of form) {
    const v = raw[f.key];
    if (v === undefined || v === "") continue;
    out[f.key] = f.type === "checkbox" ? v === "yes" : f.type === "number" ? Number(v) : v;
  }
  return out;
}

export function TestRunModal({
  open,
  onClose,
  workflowId,
  definition,
  form,
}: {
  open: boolean;
  onClose: () => void;
  workflowId: number;
  definition: HdWorkflowDefinition;
  form: HdFormField[];
}) {
  const titleId = useId();
  const fmt = useFormatDate();
  const people = usePeople();
  const questions = form.filter(sampleable);
  const approvals = definition.steps.filter((s) => s.kind === "approval");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [declineAt, setDeclineAt] = useState("");
  const [requesterId, setRequesterId] = useState<number | null>(null);
  const requester = people?.find((p) => p.id === requesterId) ?? null;
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setResult(null);
      setError("");
    }
  }, [open]);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const d = await sendJson(
        `/api/helpdesk/admin/workflows/${workflowId}/test-run`,
        "POST",
        { definition, answers: toAnswers(form, answers), decline_at: declineAt || undefined, requester_id: requesterId ?? undefined },
        "Couldn't run the test."
      );
      setResult(itemOf<SimulationResult>(d, "test"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-surface shadow-modal">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <FlaskConical className="h-4 w-4 text-compass-600" aria-hidden /> Test run
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">What each step would do, with these answers. Nothing is created or sent.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm")}>
          <X aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">
              Requester: <span className="text-slate-800">{requester ? requester.name || requester.username : "You"}</span>
              {requester && (
                <button type="button" className="link ml-2 text-xs" onClick={() => setRequesterId(null)}>
                  Use me
                </button>
              )}
            </p>
            <EntityPicker options={(people ?? []).map(personOption)} onPick={setRequesterId} label="Test as requester" placeholder="Search people…" />
            <p className="mt-1 text-xs text-slate-500">Their manager approves; their directory entry feeds Only if and routes.</p>
          </div>
          {approvals.length > 0 && (
            <Field label="Approvals">
              <Select value={declineAt} onChange={(e) => setDeclineAt(e.target.value)}>
                <option value="">Everyone approves</option>
                {approvals.map((s) => (
                  <option key={s.key} value={s.key}>
                    Declined at: {(s as { title?: string }).title || s.key}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {questions.length > 0 && (
          <fieldset className="mt-4">
            <legend className={EYEBROW_TEXT}>Test answers</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {questions.map((f) => (
                <SampleAnswer key={f.key} field={f} value={answers[f.key] ?? ""} onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))} />
              ))}
            </div>
          </fieldset>
        )}
        <div className="mt-4">
          <Button icon={<FlaskConical />} busy={busy} onClick={run}>
            {result ? "Run again" : "Run test"}
          </Button>
        </div>
        <FormError className="mt-4">{error}</FormError>
        {result && (
          <div className="mt-5" aria-live="polite">
            {result.warnings.length > 0 && (
              <ul className="notice-warn mb-4 space-y-1 rounded-lg border px-3 py-2 text-sm">
                {result.warnings.map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            )}
            <ol className="space-y-3">
              {(result.steps as SimStep[]).map((s, i) => (
                <li
                  key={`${s.key}-${i}`}
                  className={`rounded-lg border p-3 ${s.depth ? "ml-6" : ""} ${s.skipped ? "border-dashed border-slate-200 bg-slate-50/60" : "border-slate-200"}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className={`flex items-center gap-2 text-sm font-semibold ${s.skipped ? "text-slate-500" : "text-slate-900"}`}>
                      {s.title}
                      {s.skipped && (
                        <Chip tone="neutral" size="sm">
                          <CircleSlash className="h-3 w-3" aria-hidden />
                          Skipped
                        </Chip>
                      )}
                    </p>
                    {!s.skipped && <p className="text-xs text-slate-500">Starts {fmt.dateTime(s.starts_at)}</p>}
                  </div>
                  {s.skipped ? (
                    <p className="mt-1 text-sm text-slate-600">{s.reason ? `Skipped: ${s.reason}` : s.outcome}</p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm text-slate-700">{s.outcome}</p>
                      {s.team_name && !s.outcome.includes(s.team_name) && (
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-600">
                          <Signpost className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                          Goes to <span className="font-medium text-slate-800">{s.team_name}</span>
                          {s.reason && <span className="text-slate-500">· {s.reason}</span>}
                        </p>
                      )}
                    </>
                  )}
                  {!s.skipped && (s.due_at || s.wait_until) && (
                    <p className="mt-1 text-xs text-slate-500">
                      {s.due_at && `Due ${fmt.dateTime(s.due_at)}`}
                      {s.wait_until && `Waits until ${fmt.dateTime(s.wait_until)}`}
                    </p>
                  )}
                  {/* Business counting (1.19.1): whose calendar counted and the holidays it passed over. */}
                  {!s.skipped && s.count_note && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-600" data-testid="count-note">
                      <CalendarDays className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                      {s.count_note}
                    </p>
                  )}
                  {s.warnings.map((w, j) => (
                    <p key={j} className="mt-1 text-xs ink-warn">
                      {w}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-slate-700">
              Ends:{" "}
              {result.ends === "solved" ? <Chip tone="ok">Request solved</Chip> : result.ends === "declined" ? <Chip tone="error">Declined</Chip> : <Chip tone="warn">Left open</Chip>}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SampleAnswer({ field: f, value, onChange }: { field: HdFormField; value: string; onChange: (v: string) => void }) {
  const label = `${f.label || f.key} (sample)`;
  if (f.type === "checkbox") {
    return (
      <Field label={label}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not answered</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      </Field>
    );
  }
  if (f.options?.length) {
    return (
      <Field label={label}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not answered</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <Field label={label}>
      <TextInput type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"} value={value} maxLength={500} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

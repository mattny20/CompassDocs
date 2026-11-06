"use client";

// A workflow task ticket's outcome (1.19.0 multi-team): the bar above the
// conversation with **Mark done** and **Can't be done**, and their two
// dialogs. Both read the task's own step from the workflow context (`task`:
// the run's pinned definition). Mark done shows the task's hand-off fields
// up front (required ones must be filled; optional ones say so) and an
// optional note for the teams after; Can't be done needs a reason and says
// what the step's on_cant_do does: the workflow stops and the
// coordinating team takes it back, or it carries on. Both POST
// /api/helpdesk/tickets/[number]/task-outcome, which solves the task
// itself.
//
// The ticket's ordinary Solve on a task with required hand-off fields is
// refused (409 {error, missing: [{key, label}], missing_keys}); the ticket
// pane then calls `openTaskOutcome(number, missing)` and this bar opens the
// same Mark done dialog with those fields marked.

import { useEffect, useId, useRef, useState } from "react";
import { CircleCheck, CircleSlash, Undo2, Workflow } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { HdTicketDetail } from "@/lib/helpdesk/types";
import type { HdMissingOutput, HdProgressStepB, HdTaskOutcomeInput, HdTaskOutputDef, HdWorkflowContext } from "./contract";
import { refreshWorkflowContext, useWorkflowContext } from "./context";

const OPEN_EVENT = "hd:task-outcome-open";

/** A 409/400 body's `missing`: [{key, label}] (keys alone from an older server). */
export function missingOf(raw: unknown): HdMissingOutput[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m): HdMissingOutput[] => {
    if (typeof m === "string") return [{ key: m, label: "" }];
    if (m && typeof m === "object" && typeof (m as HdMissingOutput).key === "string") {
      const o = m as HdMissingOutput;
      return [{ key: o.key, label: typeof o.label === "string" ? o.label : "" }];
    }
    return [];
  });
}

/** Open the Mark done dialog of the task ticket shown (after a refused Solve). */
export function openTaskOutcome(number: number, missing?: unknown) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { number, missing: missingOf(missing) } }));
}

/** Is this ticket a workflow task (a child ticket of a request)? */
export const isTaskTicket = (d: Pick<HdTicketDetail, "parent" | "ticket">) => !!d.parent && d.ticket.source === "workflow";

/** All steps in order, group members flattened. */
export function flatSteps(steps: HdProgressStepB[] | undefined): HdProgressStepB[] {
  return (steps ?? []).flatMap((s) => (s.children?.length ? s.children : [s]));
}

export function taskStepOf(ctx: HdWorkflowContext | null, number: number): HdProgressStepB | null {
  if (!ctx?.workflow) return null;
  const all = flatSteps(ctx.workflow.steps);
  return all.find((s) => s.task_ticket_number === number) ?? (ctx.task ? all.find((s) => s.key === ctx.task?.step_key) ?? null : null);
}

async function postOutcome(number: number, body: HdTaskOutcomeInput): Promise<{ ok: true } | { ok: false; error: string; missing: HdMissingOutput[] }> {
  const res = await fetch(`/api/helpdesk/tickets/${number}/task-outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; missing?: unknown };
  if (res.ok) return { ok: true };
  return { ok: false, error: data.error || "Couldn't record the outcome.", missing: missingOf(data.missing) };
}

export function TaskOutcomeBar({ detail, onChanged }: { detail: HdTicketDetail; onChanged?: () => void }) {
  const t = detail.ticket;
  const isTask = isTaskTicket(detail);
  const { ctx } = useWorkflowContext(isTask ? t.number : null);
  const [open, setOpen] = useState<"" | "done" | "cant">("");
  const [missing, setMissing] = useState<HdMissingOutput[]>([]);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ number: number; missing: HdMissingOutput[] }>).detail;
      if (d?.number !== t.number) return;
      setMissing(d.missing);
      setOpen("done");
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, [t.number]);

  if (!isTask) return null;
  const step = taskStepOf(ctx, t.number);
  const title = ctx?.task?.title ?? step?.title ?? t.subject;
  const closed = t.status === "solved" || t.status === "closed";
  const coordinator = ctx?.task?.coordinating_team?.name ?? null;

  if (closed || step?.state === "done" || step?.state === "failed") {
    const failed = step?.state === "failed" || step?.outcome === "cant_do";
    return (
      <div className={`${failed ? "notice-warn" : "notice-ok"} flex items-start gap-2 rounded-lg border px-3 py-2 text-sm`} role="status">
        {failed ? <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
        <p className="min-w-0">
          {failed ? (
            <>
              Marked can&apos;t be done{step?.note ? `: ${step.note}` : "."}
              {ctx?.task?.on_cant_do === "continue" ? " The workflow carried on." : ` ${coordinator ?? "The request's team"} has taken the request back.`}
            </>
          ) : (
            <>Done. {step?.outputs?.length ? "The hand-off went to the request." : "The workflow has moved on."}</>
          )}
        </p>
      </div>
    );
  }
  if (!detail.can_work) return null;

  const done = () => {
    setOpen("");
    refreshWorkflowContext(t.number);
    onChanged?.();
  };

  return (
    <>
      <section aria-label="Workflow task" className={`${CARD_CLASS} flex flex-wrap items-center gap-3 px-4 py-3`}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-compass-50 text-compass-700" aria-hidden>
          <Workflow className="h-4 w-4" />
        </span>
        {/* basis: below ~16rem beside the buttons, the buttons wrap under the text. */}
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-semibold text-slate-900">Workflow task: {title}</p>
          <p className="text-xs text-slate-500">
            {ctx?.task?.outputs.length
              ? `When it's done, mark it done and fill in ${ctx.task.outputs.length === 1 ? "the hand-off field" : `the ${ctx.task.outputs.length} hand-off fields`}.`
              : "When it's done, mark it done so the workflow moves on."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" icon={<CircleSlash />} onClick={() => setOpen("cant")}>
            Can&apos;t be done
          </Button>
          <Button
            icon={<CircleCheck />}
            onClick={() => {
              setMissing([]);
              setOpen("done");
            }}
          >
            Mark done
          </Button>
        </div>
      </section>
      <MarkDoneDialog open={open === "done"} onClose={() => setOpen("")} number={t.number} title={title} outputs={ctx?.task?.outputs ?? []} missing={missing} coordinator={coordinator} onDone={done} />
      <CantDoDialog
        open={open === "cant"}
        onClose={() => setOpen("")}
        number={t.number}
        title={title}
        mode={ctx?.task?.on_cant_do ?? null}
        coordinator={coordinator}
        onDone={done}
      />
    </>
  );
}

// --- Mark done ------------------------------------------------------------------------

type Raw = Record<string, string>;

function outputError(o: HdTaskOutputDef, v: string): string | undefined {
  if (!v.trim()) return o.required ? `Fill in ${o.label.toLowerCase() || "this field"}.` : undefined;
  if (o.type === "number" && !Number.isFinite(Number(v))) return "Enter a number.";
  return undefined;
}

function toValue(o: HdTaskOutputDef, v: string): string | number | boolean | null {
  if (!v.trim()) return null;
  if (o.type === "number") return Number(v);
  if (o.type === "yes_no") return v === "yes";
  return v.trim();
}

export function MarkDoneDialog({
  open,
  onClose,
  number,
  title,
  outputs,
  missing,
  coordinator,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  title: string;
  outputs: HdTaskOutputDef[];
  missing: HdMissingOutput[];
  coordinator: string | null;
  onDone: () => void;
}) {
  const titleId = useId();
  const [raw, setRaw] = useState<Raw>({});
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Fields the server said are missing on the last try.
  const [refused, setRefused] = useState<HdMissingOutput[]>([]);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    setError("");
    const e: Record<string, string> = {};
    for (const m of missing) {
      const label = outputs.find((x) => x.key === m.key)?.label || m.label;
      e[m.key] = label ? `Fill in ${label.toLowerCase()}.` : "Needed to finish.";
    }
    setErrors(e);
  }, [open, missing, outputs]);

  // Fields the server asked for that the page doesn't know (the context not loaded yet), with the server's labels.
  const unknown = [...missing, ...refused].filter((m, i, a) => !outputs.some((o) => o.key === m.key) && a.findIndex((x) => x.key === m.key) === i);
  const all: HdTaskOutputDef[] = [
    ...outputs,
    ...unknown.map((m) => ({ key: m.key, label: m.label || (m.key.charAt(0).toUpperCase() + m.key.slice(1)).replace(/_/g, " "), type: "text" as const, required: true })),
  ];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const o of all) {
      const m = outputError(o, raw[o.key] ?? "");
      if (m) errs[o.key] = m;
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      form.current?.querySelector<HTMLElement>(`[name="${Object.keys(errs)[0]}"]`)?.focus();
      return;
    }
    setBusy(true);
    setError("");
    const values: Record<string, string | number | boolean | null> = {};
    for (const o of all) values[o.key] = toValue(o, raw[o.key] ?? "");
    const r = await postOutcome(number, { outcome: "done", outputs: values, handoff_note: note.trim() || undefined }).catch(() => ({
      ok: false as const,
      error: "Couldn't reach the server.",
      missing: [] as HdMissingOutput[],
    }));
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      if (r.missing.length) {
        setRefused(r.missing);
        setErrors(
          Object.fromEntries(
            r.missing.map((m) => {
              const label = outputs.find((o) => o.key === m.key)?.label || m.label;
              return [m.key, label ? `Fill in ${label.toLowerCase()}.` : "Needed to finish."];
            })
          )
        );
      }
      return;
    }
    toast("ok", `"${title}" done. The workflow moves on.`);
    setRaw({});
    setNote("");
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-slate-200 bg-surface shadow-modal">
      <form ref={form} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Mark &ldquo;{title}&rdquo; done
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {all.length
              ? `${coordinator ?? "The request's team"} and the teams after you see what you fill in here.`
              : "The workflow moves on to its next step."}
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {all.map((o, i) => (
            <OutputInput
              key={o.key}
              out={o}
              autoFocus={i === 0}
              value={raw[o.key] ?? ""}
              error={errors[o.key]}
              onChange={(v) => {
                setRaw((r) => ({ ...r, [o.key]: v }));
                if (errors[o.key])
                  setErrors((er) => {
                    const next = { ...er };
                    delete next[o.key];
                    return next;
                  });
              }}
            />
          ))}
          <Field label="Note for the next teams (optional)" help="Shown with the hand-off on the request.">
            <Textarea value={note} maxLength={2000} className="h-20" onChange={(e) => setNote(e.target.value)} data-autofocus={all.length ? undefined : true} />
          </Field>
          <FormError>{error}</FormError>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" icon={<CircleCheck />} busy={busy}>
            Mark done
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function OutputInput({
  out,
  value,
  error,
  autoFocus,
  onChange,
}: {
  out: HdTaskOutputDef;
  value: string;
  error?: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
}) {
  const label = `${out.label || out.key}${out.required ? "" : " (optional)"}`;
  const common = { name: out.key, "aria-required": out.required || undefined, "data-autofocus": autoFocus || undefined } as const;
  if (out.type === "select" || out.type === "yes_no") {
    const opts = out.type === "yes_no" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : out.options ?? [];
    return (
      <Field label={label} error={error}>
        <Select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <Field label={label} error={error} size={out.type === "text" ? "full" : "sm"}>
      <TextInput
        {...common}
        type={out.type === "number" ? "number" : out.type === "date" ? "date" : "text"}
        inputMode={out.type === "number" ? "decimal" : undefined}
        value={value}
        maxLength={500}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// --- Can't be done ------------------------------------------------------------------

export function CantDoDialog({
  open,
  onClose,
  number,
  title,
  mode,
  coordinator,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  title: string;
  /** The step's on_cant_do; null while the task's step is unknown (the context not loaded). */
  mode: "stop" | "continue" | null;
  coordinator: string | null;
  onDone: () => void;
}) {
  const titleId = useId();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const who = coordinator ?? "the request's team";

  useEffect(() => {
    if (open) {
      setError("");
      setNoteError("");
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      setNoteError("Say why it can't be done.");
      box.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    const r = await postOutcome(number, { outcome: "cant_do", note: note.trim() }).catch(() => ({ ok: false as const, error: "Couldn't reach the server.", missing: [] }));
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast(
      "ok",
      mode === "stop" ? `Handed back to ${who}.` : mode === "continue" ? `"${title}" marked can't be done. The workflow carries on.` : `"${title}" marked can't be done.`
    );
    setNote("");
    onDone();
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface shadow-modal">
      <form onSubmit={submit} noValidate>
        <div className="px-5 pt-5">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Can&apos;t do &ldquo;{title}&rdquo;?
          </h2>
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {mode === "stop" ? <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden /> : <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />}
            <span>
              {mode === "stop" ? (
                <>
                  The workflow stops and <b className="font-semibold">{who}</b> takes it back. They can retry this step, skip it or cancel the workflow.
                </>
              ) : mode === "continue" ? (
                <>The workflow carries on with its next step. Your reason shows on the request&apos;s progress.</>
              ) : (
                <>Depending on the step, the workflow carries on or stops for {who}. Your reason shows on the request&apos;s progress.</>
              )}
            </span>
          </p>
          <div className="mt-4">
            <Field label="Why can't it be done?" error={noteError} help={`${coordinator ?? "The request's team"} sees this.`}>
              <Textarea
                ref={box}
                data-autofocus
                aria-required
                value={note}
                maxLength={2000}
                className="h-24"
                onChange={(e) => {
                  setNote(e.target.value);
                  if (noteError) setNoteError("");
                }}
              />
            </Field>
          </div>
          <FormError className="mt-3">{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" icon={mode === "stop" ? <Undo2 /> : <CircleSlash />} busy={busy}>
            {mode === "stop" ? `Hand back to ${coordinator ?? "the request's team"}` : "Mark can't be done"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

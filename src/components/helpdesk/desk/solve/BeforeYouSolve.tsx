"use client";

// "Before you solve" (1.20.5, lib/helpdesk/solve-requirements). When a
// requirement set (Desk settings → Before you solve) matches the open ticket,
// the desk's solve flow (Solve, `e`, the status menu, Send and set Solved, a
// macro that solves) asks here first what a solve still needs. Something
// missing, or an optional closing field not answered yet: the dialog opens
// with what is missing on the ticket (each with a quick setter where the pane
// has a control for it) and the closing fields, drawn with the request form's
// own field control. Nothing missing: no dialog, and Solve works as it always
// has.
//
//   const extra = await askBeforeYouSolve(number, { applies: d.before_solve, subject });
//   if (extra === false) return;            // cancelled, or checklists block it
//   … solve, sending extra.solve_answers and extra.solve_fields with it …
//
// The dialog stores nothing itself: the closing answers and the ticket fields
// it set travel with the solve and are saved in the solve's transaction, so
// cancelling changes nothing and the composer's text is never touched. Two
// setters are actions of their own, as in the side panel: Link an asset and
// Log time are saved when pressed. Before it hands back, the dialog asks the
// server to check the answers (POST …/solve-requirements), so a bad answer is
// said here, not after the dialog closed.
//
// BeforeYouSolveHost is mounted once by the ticket pane; without it the solve
// goes ahead and the server decides.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, CircleCheck } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Modal } from "@/components/Modal";
import { Field, Select, TextInput } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import { useAppSettings } from "@/components/SettingsProvider";
import { eventWhen } from "@/lib/helpdesk/desk-calendar-shared";
import type { HdFormAnswers, HdFormField } from "@/lib/helpdesk/types";
import type { HdAssetOption, HdAssetOptions } from "@/lib/helpdesk/assets-shared";
import { formatMinutes, parseDuration, TIME_LIMITS } from "@/lib/helpdesk/time-shared";
import {
  SOLVE_TICKET_FIELDS,
  SOLVE_TICKET_FIELD_LABEL,
  solveAnswerKey,
  type HdSolveCheck,
  type HdSolveTicketField,
} from "@/lib/helpdesk/solve-requirements-shared";
import { customFieldAsFormField, type HdSolveCustomField } from "@/lib/helpdesk/custom-fields-shared";
import { FormFieldControl, isBlank } from "@/components/helpdesk/help/RequestForm";
import { getJson, listOf, sendJson } from "../api";
import { useDeskCounts } from "../counts";
import { useCan, useDeskMe } from "../me";
import { checklistsHoldSolve } from "../checklists/TicketChecklists";
import { findCategory } from "@/lib/helpdesk/categories-shared";
import { useDeskCategories } from "../categories/categories";
import { CategoryFields } from "../categories/CategoryFields";

/** What the dialog hands the solve: sent as `solve_answers` and (PATCH: merged into the patch; a reply: `solve_fields`). */
export interface SolveExtras {
  solve_answers: HdFormAnswers;
  /**
   * 1.20.6: `setup_complete` marks the ticket's event setup complete with the solve (lib/helpdesk/desk-calendar);
   * `custom_fields` are the custom fields a set requires, by field key (lib/helpdesk/custom-fields).
   */
  solve_fields: {
    assignee_id?: number;
    team_id?: number;
    category?: string;
    subcategory?: string;
    tags?: string[];
    setup_complete?: boolean;
    custom_fields?: Record<string, HdFormAnswers[string]>;
  };
}

type Ask = {
  number: number;
  subject: string;
  reply: boolean;
  check: HdSolveCheck;
  resolve: (v: SolveExtras | null | false) => void;
};

let host: ((a: Ask) => void) | null = null;

/**
 * Before a solve: what to send with it, null when there is nothing to ask,
 * false when the solve should not go ahead (cancelled, or required checklist
 * items hold it). `applies` is the ticket detail's `before_solve`: without it
 * nothing is asked and no request is made (`force` asks anyway, after the
 * server refused a solve). `reply`: a public reply is about to be sent with
 * the solve, which counts as the reply a set may require.
 */
export async function askBeforeYouSolve(
  number: number,
  opts: { applies?: boolean; force?: boolean; reply?: boolean; subject?: string } = {}
): Promise<SolveExtras | null | false> {
  if ((!opts.applies && !opts.force) || !host) return null;
  // 1.20.6: one ask at a time. A second press of Solve while the first is
  // still being checked (or its dialog is open) does nothing, instead of
  // queueing a second dialog that opened after the first was cancelled.
  if (asking) return false;
  asking = true;
  try {
    return await askOnce(number, opts);
  } finally {
    asking = false;
  }
}

let asking = false;

async function askOnce(
  number: number,
  opts: { applies?: boolean; force?: boolean; reply?: boolean; subject?: string }
): Promise<SolveExtras | null | false> {
  if (!host) return null;
  let check: HdSolveCheck;
  try {
    check = await getJson<HdSolveCheck>(`/api/helpdesk/tickets/${number}/solve-requirements${opts.reply ? "?reply=1" : ""}`);
  } catch {
    return null; // the server decides
  }
  if (!check.applies || (!check.missing.length && !check.optional_open)) return null;
  // Required checklist items would refuse the solve: say so now, not after the dialog.
  if (await checklistsHoldSolve(number)) return false;
  const h = host;
  return new Promise((resolve) => h({ number, subject: opts.subject ?? "", reply: opts.reply === true, check, resolve }));
}

export function BeforeYouSolveHost({ onChanged }: { /** A setter that saves at once (an asset linked, time logged) changed the ticket. */ onChanged?: () => void }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    host = (a) => setAsk(a);
    return () => {
      host = null;
    };
  }, []);
  if (!ask) return null;
  return (
    <BeforeYouSolveDialog
      key={ask.number}
      ask={ask}
      onChanged={onChanged}
      onDone={(v) => {
        ask.resolve(v);
        setAsk(null);
      }}
    />
  );
}

interface Agent {
  user_id: number;
  name: string;
}

const TAG_RE = /^[\p{L}\p{N} _-]{1,40}$/u;
/** 1.20.6: a custom field's control key (its own namespace beside the closing fields'). */
const customKey = (key: string) => `cf_${key}`;
/**
 * 1.20.6: a custom field as the request form's control draws it. A yes/no is drawn as a list (Yes, No): a tick box
 * can't tell "No" from "not answered", and No is an answer.
 */
function customControl(f: HdSolveCustomField): HdFormField {
  if (f.type === "checkbox") {
    return { key: customKey(f.key), label: f.label, type: "select", required: true, help: f.help || undefined, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] };
  }
  return { ...customFieldAsFormField(f, true), key: customKey(f.key) };
}
/** A field key safe in an element id: the set's id keeps two sets' same-named fields apart. */
const controlKey = (setId: number, key: string) => `s${setId}_${key}`;

function BeforeYouSolveDialog({ ask, onDone, onChanged }: { ask: Ask; onDone: (v: SolveExtras | null | false) => void; onChanged?: () => void }) {
  const { check, number, reply } = ask;
  const me = useDeskMe();
  const can$ = useCan();
  const { counts } = useDeskCounts();
  const titleId = useId();
  const refs = useRef(new Map<string, HTMLElement | null>());

  // The ticket fields missing when the dialog opened, in the settings page's order.
  const unmet = useMemo(
    () => SOLVE_TICKET_FIELDS.filter((f) => check.missing.some((m) => m.kind === "ticket_field" && m.field === f)),
    [check]
  );
  const sets = useMemo(() => check.sets.filter((s) => s.fields.length > 0), [check]);
  // 1.20.6: the ticket's event waits for "Setup complete" (lib/helpdesk/desk-calendar): a tick box here marks it with the solve.
  const needsSetup = check.missing.some((m) => m.kind === "event_setup");
  const [setupDone, setSetupDone] = useState(false);
  const { timezone: tz, time_format } = useAppSettings();
  // 1.20.6: the custom fields a matching set requires that have no value yet, each once.
  const customUnmet = useMemo(() => {
    const out: HdSolveCustomField[] = [];
    for (const s of check.sets) for (const f of s.custom_fields ?? []) if (!f.met && !out.some((x) => x.id === f.id)) out.push(f);
    return out;
  }, [check]);
  const [custom, setCustom] = useState<HdFormAnswers>({});
  const customBad = (f: HdSolveCustomField) => isBlank(custom[f.key]) || (f.type === "number" && Number.isNaN(Number(custom[f.key])));
  const customError = (f: HdSolveCustomField): string | undefined => {
    if (!tried) return undefined;
    if (isBlank(custom[f.key])) return f.type === "choice" || f.type === "select" || f.type === "checkbox" ? "Pick one." : "This is needed.";
    if (f.type === "number" && Number.isNaN(Number(custom[f.key]))) return "Enter a number.";
    return undefined;
  };

  const [values, setValues] = useState<HdFormAnswers>(() => ({ ...check.answers }));
  const [assignee, setAssignee] = useState(0);
  const [team, setTeam] = useState(0);
  // 1.20.6: picked from the desk admin's list (categories/CategoryFields). A missing sub-category starts from the ticket's category.
  const [category, setCategory] = useState(() => (check.missing.some((m) => m.kind === "ticket_field" && m.field === "category") ? "" : check.ticket.category));
  const [subcategory, setSubcategory] = useState("");
  const { list: categoryList } = useDeskCategories();
  /** The chosen category has sub-categories to pick from. */
  const subsOffered = (findCategory(categoryList ?? [], category)?.subcategories ?? []).some((x) => !x.archived);
  const [tag, setTag] = useState("");
  /** Setters that saved at once: the field → what was done ("Logged 30m"). */
  const [done, setDone] = useState<Partial<Record<HdSolveTicketField, string>>>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Who the owner picker offers follows the desk role, as the side panel's does.
  const canAssignOthers = can$("tickets.assign_any") || can$("tickets.assign_team");
  const canAssign = canAssignOthers || can$("tickets.assign_self");
  const canTeam = can$("tickets.transfer_team");
  const teamForAgents = team || check.ticket.team_id || 0;
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const wantsAgents = unmet.includes("assignee") && canAssignOthers;
  useEffect(() => {
    if (!wantsAgents) return;
    let live = true;
    getJson(`/api/helpdesk/agents${teamForAgents ? `?team=${teamForAgents}` : ""}`)
      .then((r) => live && setAgents(listOf<Agent & { id?: number }>(r, "agents").map((a) => ({ name: a.name, user_id: a.user_id ?? a.id ?? 0 }))))
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [wantsAgents, teamForAgents]);
  // The team's agents; and yourself, when you may take it but aren't one of them (a manager who works every team).
  const listed = canAssignOthers ? (agents ?? []) : [];
  const mayTake = can$("tickets.assign_self") || can$("tickets.assign_any");
  const agentOptions = mayTake && !listed.some((a) => a.user_id === me.id) ? [{ user_id: me.id, name: me.name }, ...listed] : listed;

  const fieldError = (f: HdSolveTicketField): string | undefined => {
    if (!tried || done[f]) return undefined;
    switch (f) {
      case "assignee":
        return assignee ? undefined : canAssign ? "Pick an owner." : "Ask a lead to assign the ticket.";
      case "team":
        return team ? undefined : canTeam ? "Pick a team." : "Ask a lead to move the ticket to a team.";
      case "category":
        return category.trim() ? undefined : "Pick a category.";
      case "subcategory":
        return subcategory.trim() || (category.trim() && !subsOffered) ? undefined : category.trim() ? "Pick a sub-category." : "Pick a category, then a sub-category.";
      case "tag":
        return tag.trim() ? (TAG_RE.test(tag.trim()) ? undefined : "Use up to 40 letters, numbers, spaces or dashes.") : "Add a tag.";
      case "asset":
        return "Link an asset.";
      case "time":
        return "Log some time.";
      case "reply":
        return "Reply to the requester first.";
    }
  };
  const answerError = (setId: number, f: HdFormField): string | undefined => {
    if (!tried) return undefined;
    const v = values[solveAnswerKey(setId, f.key)];
    if (f.required && isBlank(v)) return f.type === "choice" ? "Pick one." : "This is needed.";
    if (f.type === "number" && !isBlank(v) && Number.isNaN(Number(v))) return "Enter a number.";
    return undefined;
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    const bad =
      unmet.some((f) => {
        if (done[f]) return false;
        if (f === "assignee") return !assignee;
        if (f === "team") return !team;
        if (f === "category") return !category.trim();
        if (f === "subcategory") return !(subcategory.trim() || (category.trim() && !subsOffered));
        if (f === "tag") return !TAG_RE.test(tag.trim());
        return true;
      }) ||
      (needsSetup && !setupDone) ||
      customUnmet.some(customBad) ||
      sets.some((s) =>
        s.fields.some((f) => {
          const v = values[solveAnswerKey(s.id, f.key)];
          return (f.required && isBlank(v)) || (f.type === "number" && !isBlank(v) && Number.isNaN(Number(v)));
        })
      );
    if (bad) {
      const firstCustom = customUnmet.find(customBad);
      if (firstCustom) {
        refs.current.get(customKey(firstCustom.key))?.focus();
        return;
      }
      // Focus the first closing field in error; the ticket fields say theirs in place.
      for (const s of sets) {
        const first = s.fields.find((f) => f.required && isBlank(values[solveAnswerKey(s.id, f.key)]));
        if (first) {
          refs.current.get(controlKey(s.id, first.key))?.focus();
          break;
        }
      }
      return;
    }
    const solve_fields: SolveExtras["solve_fields"] = {};
    if (unmet.includes("team") && team) solve_fields.team_id = team;
    if (unmet.includes("assignee") && assignee) solve_fields.assignee_id = assignee;
    if (unmet.includes("category") || (unmet.includes("subcategory") && category.trim() !== check.ticket.category)) solve_fields.category = category.trim();
    if (unmet.includes("subcategory") && subcategory.trim()) solve_fields.subcategory = subcategory.trim();
    if (unmet.includes("tag")) {
      const t = tag.trim().toLowerCase();
      solve_fields.tags = check.ticket.tags.includes(t) ? check.ticket.tags : [...check.ticket.tags, t];
    }
    if (needsSetup && setupDone) solve_fields.setup_complete = true;
    // 1.20.6: the custom fields filled in here are stored by the solve itself, like the ticket fields above.
    if (customUnmet.length) {
      solve_fields.custom_fields = Object.fromEntries(
        customUnmet.map((f) => {
          const v = custom[f.key];
          return [f.key, f.type === "checkbox" ? v === "yes" : f.type === "number" ? Number(v) : (v ?? null)];
        })
      );
    }
    // Only what changed is sent: an answer left as it was keeps who gave it and when.
    const solve_answers: HdFormAnswers = {};
    for (const s of sets) {
      for (const f of s.fields) {
        const k = solveAnswerKey(s.id, f.key);
        const now = isBlank(values[k]) && f.type !== "checkbox" ? null : (values[k] ?? null);
        const was = check.answers[k] ?? null;
        if (String(now ?? "") !== String(was ?? "")) solve_answers[k] = now;
      }
    }
    setBusy(true);
    try {
      const r = await sendJson<HdSolveCheck>(`/api/helpdesk/tickets/${number}/solve-requirements`, "POST", { solve_answers, solve_fields, reply }, "Couldn't check the details.");
      if (r.missing.length) {
        setError(r.error ?? "Something is still missing.");
        return;
      }
      onDone({ solve_answers, solve_fields });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const teams = counts?.teams ?? [];
  const nothingRequired = check.missing.length === 0;

  return (
    <Modal
      open
      onClose={() => onDone(false)}
      labelledBy={titleId}
      className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6"
    >
      <form onSubmit={submit} noValidate data-testid="before-you-solve">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <CircleCheck className="h-5 w-5 shrink-0 text-slate-700" aria-hidden />
          Before you solve #{number}
        </h2>
        {ask.subject && <p className="mt-1 text-sm text-slate-600">{ask.subject}</p>}
        <p className="mt-2 text-sm text-slate-500">
          {nothingRequired ? "Nothing here is required. Add what you know, then solve." : "Fill these in to solve the ticket. Nothing is saved if you cancel."}
        </p>

        {(unmet.length > 0 || customUnmet.length > 0) && (
          <section className="mt-4" aria-labelledby={`${titleId}-ticket`}>
            <h3 id={`${titleId}-ticket`} className={EYEBROW_TEXT}>
              On the ticket
            </h3>
            <div className="mt-2 flex flex-col gap-3">
              {unmet.map((f) =>
                done[f] ? (
                  <DoneRow key={f} label={SOLVE_TICKET_FIELD_LABEL[f]} what={done[f]!} />
                ) : f === "assignee" ? (
                  canAssign ? (
                    <Field key={f} label="Owner" error={fieldError(f)}>
                      <Select value={String(assignee)} onChange={(e) => setAssignee(Number(e.target.value))} data-testid="bys-owner">
                        <option value="0">Choose…</option>
                        {agentOptions.map((a) => (
                          <option key={a.user_id} value={a.user_id}>
                            {a.user_id === me.id ? `${a.name} (you)` : a.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <CantRow key={f} label="Owner" text="This ticket needs an owner. Ask a lead to assign it." error={fieldError(f)} />
                  )
                ) : f === "team" ? (
                  canTeam ? (
                    <Field key={f} label="Team" error={fieldError(f)}>
                      <Select value={String(team)} onChange={(e) => setTeam(Number(e.target.value))} data-testid="bys-team">
                        <option value="0">Choose…</option>
                        {teams.map((t) => (
                          <option key={t.team_id} value={t.team_id}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <CantRow key={f} label="Team" text="This ticket needs a team. Ask a lead to move it." error={fieldError(f)} />
                  )
                ) : f === "category" || (f === "subcategory" && !unmet.includes("category")) ? (
                  // One pair of Selects for both: the category, then a sub-category of it.
                  <CategoryFields
                    key={f}
                    value={{ category, subcategory }}
                    onChange={(next) => {
                      setCategory(next.category);
                      setSubcategory(next.subcategory);
                    }}
                    none="Choose…"
                    noneSub={unmet.includes("subcategory") ? "Choose…" : "None"}
                    errors={{ category: unmet.includes("category") ? fieldError("category") : undefined, subcategory: unmet.includes("subcategory") ? fieldError("subcategory") : undefined }}
                    testid="bys"
                  />
                ) : f === "subcategory" ? null : f === "tag" ? (
                  <Field key={f} label="Tag" help="A short word that helps you find and report on tickets: vpn, mfa, onboarding." error={fieldError(f)}>
                    <TextInput value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} autoCapitalize="none" data-testid="bys-tag" />
                  </Field>
                ) : f === "asset" ? (
                  <AssetQuick
                    key={f}
                    number={number}
                    error={fieldError(f)}
                    onLinked={(what) => {
                      setDone((d) => ({ ...d, asset: `Linked ${what}` }));
                      onChanged?.();
                    }}
                  />
                ) : f === "time" ? (
                  <TimeQuick
                    key={f}
                    number={number}
                    error={fieldError(f)}
                    onLogged={(minutes) => {
                      setDone((d) => ({ ...d, time: `Logged ${formatMinutes(minutes)}` }));
                      onChanged?.();
                    }}
                  />
                ) : (
                  <CantRow
                    key={f}
                    label="Reply"
                    text="The requester hasn't had a reply yet. Cancel, write your reply, then choose Send and set Solved."
                    error={fieldError(f)}
                  />
                )
              )}
              {/* 1.20.6: custom fields a set requires, drawn with the request form's control. */}
              {customUnmet.map((f) => (
                <div key={`cf-${f.id}`} data-testid={`bys-custom-${f.key}`}>
                  <FormFieldControl
                    field={customControl(f)}
                    value={custom[f.key]}
                    onChange={(v) => setCustom((cur) => ({ ...cur, [f.key]: v }))}
                    error={customError(f)}
                    refs={refs}
                    prefilled={false}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {needsSetup && (
          <section className="mt-5" aria-labelledby={`${titleId}-event`} data-testid="bys-event">
            <h3 id={`${titleId}-event`} className={EYEBROW_TEXT}>
              Event
            </h3>
            {check.event_setup && (
              <p className="mt-2 text-sm text-slate-700">
                {eventWhen(check.event_setup, tz, time_format === "12h")}
                {check.event_setup.place ? ` · ${check.event_setup.place}` : ""}
              </p>
            )}
            <label className="mt-2 flex items-start gap-2 text-sm text-slate-800">
              <input type="checkbox" className="mt-0.5" checked={setupDone} onChange={(e) => setSetupDone(e.target.checked)} data-testid="bys-setup" aria-describedby={`${titleId}-event-help`} />
              <span>
                <span className="font-medium">Setup complete</span>
                <span id={`${titleId}-event-help`} className="block text-xs text-slate-500">
                  Everything for the event is in place. It is recorded with your name when the ticket is solved.
                </span>
              </span>
            </label>
            {tried && !setupDone && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                Tick this once the setup is done. The ticket can&apos;t be solved before.
              </p>
            )}
          </section>
        )}

        {sets.map((s) => (
          <section key={s.id} className="mt-5" aria-labelledby={`${titleId}-set-${s.id}`}>
            <h3 id={`${titleId}-set-${s.id}`} className={EYEBROW_TEXT}>
              {s.name}
            </h3>
            <div className="mt-2 flex flex-col gap-4">
              {s.fields.map((f) => {
                const k = solveAnswerKey(s.id, f.key);
                return (
                  <FormFieldControl
                    key={k}
                    field={{ ...f, key: controlKey(s.id, f.key) }}
                    value={values[k]}
                    onChange={(v) => setValues((cur) => ({ ...cur, [k]: v }))}
                    error={answerError(s.id, f)}
                    refs={refs}
                    prefilled={false}
                  />
                );
              })}
            </div>
          </section>
        ))}

        {error && (
          <p role="alert" className="notice-error mt-4 rounded-lg border px-3 py-2 text-sm">
            {error}
          </p>
        )}

        {/* The actions stay in view while a long form scrolls inside the dialog. 1.20.6: they stick to the dialog's
            edge (its padding included), so they no longer sit over the last line above them. */}
        <div className="sticky -bottom-5 -mx-5 -mb-5 mt-5 flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-slate-100 bg-surface px-5 py-3 sm:-bottom-6 sm:-mx-6 sm:-mb-6 sm:px-6">
          <Button variant="secondary" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {reply ? "Send and solve" : "Solve"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A requirement a setter here just met. */
function DoneRow({ label, what }: { label: string; what: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-700">
      <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <span>
        <span className="font-medium">{label}.</span> {what}.
      </span>
    </p>
  );
}

/** A requirement this dialog can't meet: what to do instead. */
function CantRow({ label, text, error }: { label: string; text: string; error?: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-500">{label}</p>
      <p className="text-sm text-slate-700">{text}</p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/** Link an asset: the requester's devices first, then a search, as the side panel's picker lists them. Saved when picked. */
function AssetQuick({ number, error, onLinked }: { number: number; error?: string; onLinked: (what: string) => void }) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<HdAssetOptions | null>(null);
  const [busy, setBusy] = useState(0);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(
      () => {
        getJson<HdAssetOptions>(`/api/helpdesk/tickets/${number}/assets/options?q=${encodeURIComponent(q.trim())}`, "Couldn't load the assets.", ctrl.signal)
          .then((d) => {
            setData(d);
            setFailed("");
          })
          .catch((e: Error) => {
            if (e.name !== "AbortError") setFailed(e.message);
          });
      },
      q.trim() ? 250 : 0
    );
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, number]);

  async function link(o: HdAssetOption) {
    setBusy(o.id);
    try {
      await sendJson(`/api/helpdesk/tickets/${number}/assets`, "POST", { asset_id: o.id }, "Couldn't link the asset.");
      onLinked(o.tag || o.name);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(0);
    }
  }

  const seen = new Set<number>();
  const options = [...(data?.assigned ?? []), ...(data?.results ?? [])].filter((o) => !o.linked && !seen.has(o.id) && !!seen.add(o.id)).slice(0, 5);
  return (
    <div data-testid="bys-asset">
      <Field label="Linked asset" help={data && !data.connected ? (data.notice ?? undefined) : "Pick the device this ticket is about. It is linked as soon as you pick it."} error={failed || error}>
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, tag or serial…" maxLength={80} autoComplete="off" />
      </Field>
      {data === null && !failed ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-500">
          <Spinner size="sm" /> Loading…
        </p>
      ) : options.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">{q.trim() ? "No asset matches." : "No devices are assigned to the requester. Search for one."}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {options.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">{o.name}</span>
                <span className="block truncate text-xs text-slate-500">{[o.tag || o.serial, o.assigned_name].filter(Boolean).join(" · ")}</span>
              </span>
              <button type="button" disabled={busy !== 0} onClick={() => link(o)} className={buttonClass("secondary", "sm")} aria-label={`Link ${o.name}`}>
                {busy === o.id && <Spinner size="sm" />}
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Log time: a duration as the time card reads it ("30m", "1h 15m"). Saved when Log time is pressed. */
function TimeQuick({ number, error, onLogged }: { number: number; error?: string; onLogged: (minutes: number) => void }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  async function log() {
    const minutes = parseDuration(raw);
    if (!minutes || minutes < 1 || minutes > TIME_LIMITS.maxMinutes) {
      setFailed("Write the time like 30m or 1h 15m.");
      return;
    }
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/tickets/${number}/time`, "POST", { minutes, note: "" }, "Couldn't log the time.");
      onLogged(minutes);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const id = useId();
  const said = failed || error;
  return (
    <div data-testid="bys-time">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-500">
        Time spent
      </label>
      <div className="flex gap-2">
        <TextInput
          id={id}
          className="min-w-0 flex-1"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setFailed("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void log();
            }
          }}
          placeholder="30m"
          maxLength={20}
          autoComplete="off"
          aria-invalid={said ? true : undefined}
          aria-describedby={`${id}-help`}
        />
        <Button variant="secondary" busy={busy} onClick={log}>
          Log time
        </Button>
      </div>
      {said ? (
        <p id={`${id}-help`} role="alert" className="mt-1 text-xs text-red-600">
          {said}
        </p>
      ) : (
        <p id={`${id}-help`} className="mt-1 text-xs text-slate-500">
          Like 30m or 1h 15m. It is logged as soon as you press Log time.
        </p>
      )}
    </div>
  );
}

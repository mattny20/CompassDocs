"use client";

// The ticket's right-hand column: who asked (from the directory), the
// properties an agent changes in place (priority, team, owner, category,
// tags), the service level, suggestions from your documents, and, on a
// request with a workflow, its progress and task tickets. Each property is
// a picker menu (STYLEGUIDE §Status chips, "A choice is a pill menu
// button"), so a change is one click and one PATCH.

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Check, ChevronDown, CircleDashed, CircleDot, CircleX, Plus, Sparkles, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { CARD_CLASS } from "@/components/Card";
import { EYEBROW_TEXT } from "@/components/Heading";
import { RelativeTime } from "@/components/RelativeTime";
import { initialsOf } from "@/components/UserAvatar";
import { promptDialog } from "@/components/Dialog";
import { SectionEmpty } from "@/components/form";
import {
  HD_PRIORITIES,
  HD_PRIORITY_LABEL,
  HD_SOURCE_LABEL,
  type HdFormAnswers,
  type HdFormField,
  type HdProgressStep,
  type HdTicketDetail,
  type HdTicketPatch,
} from "@/lib/helpdesk/types";
import { getJson, listOf } from "../api";
import { useDeskCounts } from "../counts";
import { useCan, useDeskMe } from "../me";
import { PickMenu } from "../PickMenu";
import { TicketContacts } from "@/components/helpdesk/contacts/TicketContacts";
import { HandoffsPanel, PartOfRequestCard } from "../workflow-multi/RequestPanels";
import { AlertDetails } from "../intake/AlertDetails";
import { PRIORITY_DOT, slaInk, statusChip, ticketHref } from "../ui";
import { AssignmentHistory } from "../assignment/AssignmentHistory";

interface Agent {
  user_id: number;
  name: string;
  availability?: string;
}

const ROW = "flex min-h-11 items-center justify-between gap-3 border-b border-slate-100 py-1.5 last:border-b-0";
const VALUE_BTN =
  "inline-flex min-w-0 max-w-44 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-slate-800 transition hover:bg-slate-100 disabled:hover:bg-transparent";

export function SidePanel({
  d,
  onPatch,
  onInsertArticle,
  onReply,
}: {
  onReply?: () => void;
  d: HdTicketDetail;
  onPatch: (patch: HdTicketPatch, ok?: string) => void;
  onInsertArticle: (title: string, url: string) => void;
}) {
  const t = d.ticket;
  const me = useDeskMe();
  const can$ = useCan();
  const { counts } = useDeskCounts();
  const [agents, setAgents] = useState<Agent[] | null>(null);

  useEffect(() => {
    let live = true;
    getJson(`/api/helpdesk/agents${t.team_id ? `?team=${t.team_id}` : ""}`)
      .then((r) => live && setAgents(listOf<Agent>(r, "agents").map((a) => ({ ...a, user_id: a.user_id ?? (a as unknown as { id: number }).id }))))
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [t.team_id]);

  const teams = counts?.teams ?? [];
  const teamOptions = [
    ...teams.map((x) => ({ value: x.team_id, label: x.name })),
    ...(t.team_id && !teams.some((x) => x.team_id === t.team_id) ? [{ value: t.team_id, label: t.team_name || "Team" }] : []),
  ];
  // Who the owner menu offers follows the desk role: anyone (assign_any),
  // the ticket's team (assign_team), or only yourself (assign_self).
  const assignable = (agents ?? []).filter((a) =>
    can$("tickets.assign_any") || can$("tickets.assign_team") ? true : a.user_id === me.id
  );
  const agentOptions = [
    { value: 0, label: "Unassigned" },
    ...assignable.map((a) => ({ value: a.user_id, label: a.user_id === me.id ? `${a.name} (you)` : a.name, hint: a.availability && a.availability !== "available" ? labelCaseAvail(a.availability) : undefined })),
    ...(t.assignee_id && agents && !agents.some((a) => a.user_id === t.assignee_id) ? [{ value: t.assignee_id, label: t.assignee_name || "Agent" }] : []),
  ];
  const can = d.can_work;
  // Agent L's calendars and per-team targets: which target applies, and why the clock is paused.
  const notes = { clock: d.clock_note ?? null, target: d.sla_target_note || null };
  const canPriority = can && can$("tickets.change_priority");
  const canTeam = can && can$("tickets.transfer_team");
  const canOwner = can && (can$("tickets.assign_any") || can$("tickets.assign_team") || can$("tickets.assign_self"));

  async function editCategory() {
    const v = await promptDialog({ title: "Category", label: "Category", initial: t.category, required: false, confirmLabel: "Save category" });
    if (v === null) return;
    onPatch({ category: v.trim().slice(0, 80) }, "Category saved.");
  }

  async function addTag() {
    const v = await promptDialog({
      title: "Add a tag",
      label: "Tag",
      help: "Short words that help you find and report on tickets: vpn, mfa, onboarding.",
      confirmLabel: "Add tag",
      validate: (s) => (/^[\p{L}\p{N} _-]{1,40}$/u.test(s.trim()) ? undefined : "Use up to 40 letters, numbers, spaces or dashes."),
    });
    if (!v) return;
    const tag = v.trim().toLowerCase();
    if (t.tags.includes(tag)) return;
    onPatch({ tags: [...t.tags, tag] }, "Tag added.");
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The people on the ticket, the requester's card first (agent O). */}
      <TicketContacts ticket={t.number} onReply={onReply} refreshKey={d.messages.length} />

      {/* An integration's ticket: the alert behind it (agent P). */}
      <AlertDetails ticket={t} canManage={can$("channels.manage") || can$("settings.manage")} />

      {/* A workflow task: the request it belongs to (agent M). */}
      <PartOfRequestCard detail={d} />

      {/* Properties */}
      <section aria-label="Properties" className={`${CARD_CLASS} px-4 py-1`}>
        <div className={ROW}>
          <span className="text-sm text-slate-500">Priority</span>
          <PickMenu
            label="Priority"
            value={t.priority}
            options={HD_PRIORITIES.slice().reverse().map((p) => ({ value: p, label: HD_PRIORITY_LABEL[p], icon: <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[p]}`} /> }))}
            onPick={(p) => onPatch({ priority: p }, `Priority set to ${HD_PRIORITY_LABEL[p]}.`)}
            trigger={(p) => (
              <button {...p} type="button" disabled={!canPriority} aria-label={`Priority: ${HD_PRIORITY_LABEL[t.priority]}`} className={VALUE_BTN}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[t.priority]}`} aria-hidden />
                {HD_PRIORITY_LABEL[t.priority]}
                {canPriority && <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />}
              </button>
            )}
          />
        </div>
        <div className={ROW}>
          <span className="text-sm text-slate-500">Team</span>
          <PickMenu
            label="Team"
            value={t.team_id ?? 0}
            options={teamOptions}
            onPick={(id) => onPatch({ team_id: id || null }, "Team changed.")}
            trigger={(p) => (
              <button {...p} type="button" disabled={!canTeam} aria-label={`Team: ${t.team_name || "None"}`} className={VALUE_BTN}>
                <span className="truncate">{t.team_name || "None"}</span>
                {canTeam && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
              </button>
            )}
          />
        </div>
        <div className={ROW}>
          <span className="text-sm text-slate-500">Owner</span>
          <PickMenu
            label="Owner"
            value={t.assignee_id ?? 0}
            options={agentOptions}
            onPick={(id) => onPatch({ assignee_id: id || null }, id ? (id === me.id ? "Assigned to you." : "Owner changed.") : "Unassigned.")}
            trigger={(p) => (
              <button {...p} type="button" disabled={!canOwner} aria-label={`Owner: ${t.assignee_id === me.id ? "You" : t.assignee_name || "Unassigned"}`} className={VALUE_BTN}>
                {t.assignee_id ? (
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-compass-100 text-3xs font-bold text-compass-700" aria-hidden>
                    {initialsOf(t.assignee_name || "?")}
                  </span>
                ) : null}
                <span className="truncate">{t.assignee_id === me.id ? "You" : t.assignee_name || "Unassigned"}</span>
                {canOwner && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
              </button>
            )}
          />
        </div>
        <div className={ROW}>
          <span className="text-sm text-slate-500">Category</span>
          <button type="button" disabled={!can} onClick={editCategory} aria-label={`Category: ${t.category || "None"}. Change`} className={VALUE_BTN}>
            <span className="truncate">{t.category || "None"}</span>
            {can && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          </button>
        </div>
        <div className={`${ROW} items-start py-2.5`}>
          <span className="text-sm text-slate-500">Tags</span>
          <ul className="flex min-w-0 flex-wrap justify-end gap-1">
            {t.tags.map((tag) => (
              <li key={tag} className={chipClass("neutral", "md", "pr-0.5")}>
                {tag}
                {can && (
                  <button
                    type="button"
                    onClick={() => onPatch({ tags: t.tags.filter((x) => x !== tag) }, "Tag removed.")}
                    aria-label={`Remove tag ${tag}`}
                    className="grid h-4 w-4 place-items-center rounded-full hover:bg-slate-200"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </li>
            ))}
            {can && (
              <li>
                <button type="button" onClick={addTag} aria-label="Add a tag" data-tt="Add a tag" className={iconButtonClass("quiet", "sm", "h-6 w-6")}>
                  <Plus aria-hidden />
                </button>
              </li>
            )}
            {!can && t.tags.length === 0 && <li className="text-sm text-slate-500">None</li>}
          </ul>
        </div>
      </section>

      {/* Who owned it, and how they got it (agent N). */}
      {can && <AssignmentHistory ticketNumber={t.number} refreshKey={t.assignee_id} />}

      {/* Service level */}
      {(d.sla.policy || d.sla.first_reply.label || d.sla.resolve.label) && (
        <section aria-labelledby="sla-h" className={`${CARD_CLASS} p-4`}>
          <h3 id="sla-h" className={EYEBROW_TEXT}>
            Due{d.sla.policy ? ` · ${HD_PRIORITY_LABEL[d.sla.policy.priority]}` : ""}
          </h3>
          <dl className="mt-2 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-700">First reply</dt>
              <dd className={`inline-flex items-center gap-1 ${slaInk(d.sla.first_reply.state)}`}>
                {d.sla.first_reply.state === "met" && <Check className="h-3.5 w-3.5" aria-hidden />}
                {d.sla.first_reply.label || "None set"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-700">Resolve</dt>
              <dd className={slaInk(d.sla.resolve.state)}>{d.sla.resolve.label || "None set"}</dd>
            </div>
          </dl>
          {notes.clock && <p className="mt-2 text-xs text-slate-500">{notes.clock}</p>}
          {notes.target && <p className="mt-2 text-xs text-slate-500">{notes.target}</p>}
          {d.sla.resolve_elapsed_percent !== null && d.sla.resolve.state !== "met" && (
            <div
              role="img"
              aria-label={`${Math.round(d.sla.resolve_elapsed_percent)}% of the resolution time used`}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"
            >
              <span
                className={`block h-full rounded-full ${
                  d.sla.resolve.state === "breached" ? "bg-red-500" : d.sla.resolve.state === "warn" ? "bg-amber-500" : "bg-compass-600"
                }`}
                style={{ width: `${Math.min(100, Math.max(2, d.sla.resolve_elapsed_percent))}%` }}
              />
            </div>
          )}
        </section>
      )}

      {/* Workflow progress (requests) */}
      {d.workflow && (
        <section aria-labelledby="wf-h" className={`${CARD_CLASS} p-4`}>
          <h3 id="wf-h" className={EYEBROW_TEXT}>
            Workflow · {d.workflow.workflow_title}
          </h3>
          <ol className="mt-2 space-y-2">
            {d.workflow.steps.map((s) => (
              <ProgressLine key={s.key} s={s} />
            ))}
          </ol>
        </section>
      )}

      {/* What each team handed on (agent M). */}
      <HandoffsPanel detail={d} />

      {/* Task tickets (children) */}
      {d.children.length > 0 && (
        <section aria-labelledby="tasks-h" className={`${CARD_CLASS} p-4`}>
          <h3 id="tasks-h" className={EYEBROW_TEXT}>
            Tasks
          </h3>
          <ul className="mt-2 space-y-1.5">
            {d.children.map((c) => {
              const chip = statusChip(c, true);
              return (
                <li key={c.id}>
                  <Link href={ticketHref(c.number)} className="flex items-center gap-2 rounded-md text-sm hover:underline">
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                      #{c.number} {c.subject}
                    </span>
                    <span className={chipClass(chip.tone, "sm")}>{chip.label}</span>
                  </Link>
                  {c.team_name && <p className="text-xs text-slate-500">{c.team_name}{c.assignee_name ? ` · ${c.assignee_name}` : ""}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* The request's form answers */}
      {d.form.length > 0 && <Answers form={d.form} answers={t.form_answers} />}

      {/* From your docs */}
      <section aria-labelledby="docs-h" className={`${CARD_CLASS} p-4`}>
        <h3 id="docs-h" className={`${EYEBROW_TEXT} flex items-center gap-1.5`}>
          <Sparkles className="h-3.5 w-3.5 text-compass-600" aria-hidden />
          From your docs
        </h3>
        {d.suggested_articles.length === 0 ? (
          <SectionEmpty className="mt-2">Nothing in your documents looks like this one yet.</SectionEmpty>
        ) : (
          <ul className="mt-2 space-y-2">
            {d.suggested_articles.map((a) => (
              <li key={a.doc_id} className="flex items-start gap-2">
                <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
                <a href={a.url} target="_blank" rel="noopener" className="min-w-0 flex-1 text-sm font-medium text-slate-800 hover:underline">
                  {a.title}
                </a>
                {can && (
                  <button
                    type="button"
                    onClick={() => onInsertArticle(a.title, a.url)}
                    aria-label={`Insert ${a.title} in the reply`}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    Insert
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="px-1 text-xs text-slate-500">
        Opened through {HD_SOURCE_LABEL[t.source] ?? t.source}
        {t.request_type_title ? ` · ${t.request_type_title}` : ""}
      </p>
    </div>
  );
}

function labelCaseAvail(a: string): string {
  return a.charAt(0).toUpperCase() + a.slice(1);
}

const STEP_ICON = {
  done: <Check className="h-3.5 w-3.5" aria-hidden />,
  active: <CircleDot className="h-3.5 w-3.5" aria-hidden />,
  declined: <CircleX className="h-3.5 w-3.5" aria-hidden />,
  failed: <CircleX className="h-3.5 w-3.5" aria-hidden />,
};

function ProgressLine({ s, nested = false }: { s: HdProgressStep; nested?: boolean }) {
  const tone =
    s.state === "done"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
      : s.state === "active"
        ? "bg-compass-600 text-white"
        : s.state === "declined" || s.state === "failed"
          ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
          : "bg-slate-100 text-slate-400";
  const stateWord = { done: "Done", active: "In progress", declined: "Declined", pending: "Not started", skipped: "Skipped", cancelled: "Cancelled", failed: "Can't be done" }[s.state];
  return (
    <li className={nested ? "ml-7" : ""}>
      <div className="flex items-start gap-2">
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${tone}`} aria-hidden>
          {STEP_ICON[s.state as keyof typeof STEP_ICON] ?? <CircleDashed className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">
            {s.task_ticket_number ? (
              <Link href={ticketHref(s.task_ticket_number)} className="hover:underline">
                {s.title}
              </Link>
            ) : (
              s.title
            )}
            <span className="sr-only">: {stateWord}</span>
          </p>
          {s.detail && <p className="text-xs text-slate-500">{s.detail}</p>}
        </div>
      </div>
      {s.children && s.children.length > 0 && (
        <ol className="mt-1.5 space-y-1.5">
          {s.children.map((c) => (
            <ProgressLine key={c.key} s={c} nested />
          ))}
        </ol>
      )}
    </li>
  );
}

function answerText(f: HdFormField, v: HdFormAnswers[string]): string {
  if (v === null || v === undefined || v === "") return "";
  if (f.type === "checkbox") return v ? "Yes" : "No";
  if (f.options?.length) return f.options.find((o) => o.value === String(v))?.label ?? String(v);
  return String(v);
}

function Answers({ form, answers }: { form: HdFormField[]; answers: HdFormAnswers }) {
  const rows = form.map((f) => ({ f, text: answerText(f, answers?.[f.key]) })).filter((r) => r.text);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="answers-h" className={`${CARD_CLASS} p-4`}>
      <h3 id="answers-h" className={EYEBROW_TEXT}>
        Request details
      </h3>
      <dl className="mt-2 space-y-2 text-sm">
        {rows.map(({ f, text }) => (
          <div key={f.key}>
            <dt className="text-xs text-slate-500">{f.label}</dt>
            <dd className="whitespace-pre-wrap text-slate-800">{text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

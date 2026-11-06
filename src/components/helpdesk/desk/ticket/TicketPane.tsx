"use client";

// The open ticket (the split view's right pane, /desk/tickets/[number]):
// its meta line and subject, the status menu and Solve, the conversation
// with the composer under it, and the side column. Loads GET
// /api/helpdesk/tickets/[number]; every change is a PATCH or a message
// POST followed by a reload of the ticket, the list and the counts.
//
// Keys (single-key shortcuts): r reply, n internal note, e solve,
// a assign to me.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, CircleCheck, Inbox, MoreHorizontal, ShieldOff, Trash2, TriangleAlert } from "lucide-react";
import { MenuItem, Popover } from "@/components/Popover";
import { useRouter } from "next/navigation";
import { confirmDialog } from "@/components/Dialog";
import { Button, iconButtonClass } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { EmptyState } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { PageHeader } from "@/components/PageHeader";
import { RelativeTime } from "@/components/RelativeTime";
import { toast } from "@/components/Toasts";
import {
  HD_IN_WORKFLOW_LABEL,
  HD_STATUSES,
  HD_STATUS_LABEL,
  type HdMacro,
  type HdStatus,
  type HdTicketDetail,
  type HdTicketPatch,
} from "@/lib/helpdesk/types";
import { ApiError, getJson, itemOf, sendJson } from "../api";
import { useDeskKeys } from "../hotkeys";
import { useCan, useDeskMe } from "../me";
import { PickMenu } from "../PickMenu";
import { useQueue } from "../queue/QueueLayout";
import { STATUS_TONE, statusChip } from "../ui";
import { Composer, type ComposerHandle } from "./Composer";
import { TicketPresence } from "../presence/TicketPresence";
import { latestMessageId } from "../presence/presence";
import { ClaudeDraftCard } from "./ClaudeDraftCard";
import { Conversation } from "./Conversation";
import { FollowButton, TicketCcRow, useTicketPeople } from "./TicketPeople";
import { SidePanel } from "./SidePanel";
import { VipChip } from "@/components/helpdesk/contacts/VipChip";
import { AutomatedChip } from "../intake/AutomatedChip";
import { OutsideCustomerChip, isPortalTicket } from "../OutsideCustomerChip";
import { BlockedRunBanner } from "../workflow-multi/BlockedRunBanner";
import { TaskOutcomeBar, openTaskOutcome } from "../workflow-multi/TaskOutcome";
import { GitMerge } from "lucide-react";
import { MenuSeparator } from "@/components/Popover";
import { MergeDialog, type MergeCandidate } from "../merge/MergeDialog";
import { MergedComposerLock, MergedNotice } from "../merge/MergeCards";
import { askTimeOnSolve } from "../time/TimeCard";
import { IncidentBanner } from "../incidents/IncidentBanner";
import { IncidentPanel } from "../incidents/IncidentPanel";
import { useIncidentMenu } from "../incidents/IncidentActions";
import { revealChecklists, TicketChecklists } from "../checklists/TicketChecklists";
import { askMaintenanceOnSolve, logMaintenanceAfterSolve, SolveMaintenanceHost, type MaintenancePlan } from "../assets/SolveMaintenance";
import { isChecklistBlock } from "@/lib/helpdesk/checklists-shared";

const PILL_TONE: Record<string, string> = {
  info: "bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-500/15 dark:text-sky-300",
  accent: "bg-compass-50 text-compass-700 hover:bg-compass-100",
  warn: "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-300",
  neutral: "bg-slate-100 text-slate-700 hover:bg-slate-200",
  ok: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300",
};

export function TicketPane({ number }: { number: number }) {
  const me = useDeskMe();
  const can$ = useCan();
  const router = useRouter();
  const { refresh: refreshQueue, qs, title } = useQueue();
  const [d, setD] = useState<HdTicketDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  // CCs and followers (1.19.1, agent V3).
  const people = useTicketPeople(number);

  const load = useCallback(
    (quiet = false) =>
      getJson<HdTicketDetail>(`/api/helpdesk/tickets/${number}`, "Couldn't load that ticket.")
        .then((r) => {
          setD(r);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!quiet) setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message });
        }),
    [number]
  );

  useEffect(() => {
    setD(null);
    setError(null);
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && load(true), 45_000);
    return () => clearInterval(t);
  }, [load]);

  const patch = useCallback(
    async (p: HdTicketPatch, ok?: string) => {
      // 1.19.3: a linked asset may log a maintenance record once solved (lib/helpdesk/assets); cancelling keeps it open.
      let maintenance: MaintenancePlan | null = null;
      if (p.status === "solved") {
        const plan = await askMaintenanceOnSolve(number, d?.ticket.subject ?? "");
        if (plan === false) return;
        maintenance = plan;
      }
      // A team that records time asks for it before a solve (1.19.1, agent V8); cancelling keeps it open.
      if (p.status === "solved" && !(await askTimeOnSolve(number, me.id))) return;
      setBusy(true);
      try {
        const r = await sendJson(`/api/helpdesk/tickets/${number}`, "PATCH", p, "Couldn't update the ticket.");
        // The route may answer with the detail, the ticket, or nothing useful.
        const t = itemOf<Partial<HdTicketDetail>>(r, "detail");
        if (t && "ticket" in t && t.messages) setD(t as HdTicketDetail);
        else await load(true);
        if (ok) toast("ok", ok);
        if (maintenance) void logMaintenanceAfterSolve(number, maintenance);
        refreshQueue();
      } catch (e) {
        // A workflow task with required hand-off fields is solved through Mark done (agent M).
        // 1.19.2: required checklist items first (agent W3): say so and show them.
        if (e instanceof ApiError && isChecklistBlock(e.message)) {
          toast("error", e.message);
          revealChecklists(number);
        } else if (e instanceof ApiError && e.status === 409 && p.status === "solved" && d?.parent) openTaskOutcome(number);
        else toast("error", (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [number, load, refreshQueue, d?.parent, d?.ticket.subject, me.id]
  );

  async function afterSend({ macro }: { macro: HdMacro | null; status: HdStatus | null }) {
    if (macro) {
      const p: HdTicketPatch = {};
      if (macro.actions.priority) p.priority = macro.actions.priority;
      if (macro.actions.team_id) p.team_id = macro.actions.team_id;
      if (macro.actions.tags_add?.length && d) p.tags = Array.from(new Set([...d.ticket.tags, ...macro.actions.tags_add]));
      if (Object.keys(p).length) await patch(p);
    }
    await load(true);
    refreshQueue();
  }

  const t = d?.ticket;
  const can = !!d?.can_work;
  const closed = t?.status === "solved" || t?.status === "closed";
  // A merged ticket is read-only: no composer, no status menu (1.19.1; the routes refuse too).
  const merged = !!t?.merged_into;

  useDeskKeys(
    {
      r: () => composer.current?.focus("public"),
      n: () => composer.current?.focus("internal"),
      e: () => t && !closed && can$("tickets.change_status") && patch({ status: "solved" }, `#${t.number} solved.`),
      a: () => t && can$("tickets.assign_self") && t.assignee_id !== me.id && patch({ assignee_id: me.id }, "Assigned to you."),
    },
    can
  );

  const back = (
    <Link href={`/desk${qs}`} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 lg:hidden">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {title}
    </Link>
  );

  if (error) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {back}
        <PageHeader className="sr-only" title={`Ticket #${number}`} />
        <EmptyState
          icon={error.status === 404 ? <Inbox /> : error.status === 403 ? <ShieldOff /> : <TriangleAlert />}
          title={error.status === 404 ? `There's no ticket #${number}` : error.status === 403 ? "This ticket belongs to another team" : "Couldn't load this ticket"}
          body={
            error.status === 404
              ? "It may have been deleted, or the number is wrong."
              : error.status === 403
                ? "You can open tickets of the teams you're in and tickets assigned to you."
                : error.message
          }
          action={error.status === 404 || error.status === 403 ? { href: `/desk${qs}`, label: "Back to the queue" } : { onClick: () => void load(), label: "Try again" }}
        />
      </div>
    );
  }

  if (!d || !t) {
    return (
      <div className="min-w-0 flex-1 p-6" aria-busy>
        <PageHeader className="sr-only" title={`Ticket #${number}`} />
        <LoadingRow className="py-16" />
      </div>
    );
  }

  const chip = statusChip(t);
  // Agent O's contact cards: the requester's card says whether they are VIP.
  const vip = (d.requester as typeof d.requester & { card?: { vip?: { vip: boolean; reason: string } } }).card?.vip;
  const statusOptions = HD_STATUSES.filter((s) => s !== "closed" || t.status === "closed").map((s) => ({ value: s, label: HD_STATUS_LABEL[s] }));

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <article aria-labelledby="ticket-subject" className="@container px-4 py-4 sm:px-6 sm:py-5">
        {back}
        <PageHeader className="sr-only" title={`Ticket #${t.number}: ${t.subject}`} />
        {/* A major incident's own ticket, or one linked to it (1.19.2, agent W1). */}
        {can && <IncidentBanner number={t.number} refreshKey={t.updated_at} />}
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[min(100%,18rem)] flex-1">
            <p className="text-xs text-slate-500">
              #{t.number}
              {t.import_ref && typeof t.source_ref?.import_label === "string" && <span data-testid="import-ref"> · {t.source_ref.import_label}</span>}
              {t.team_name && ` · ${t.team_name}`} · opened <RelativeTime value={t.created_at} /> by {t.requester_name || t.requester_email}
              {d.parent && (
                <>
                  {" "}· task of{" "}
                  <Link href={`/desk/tickets/${d.parent.number}${qs}`} className="link">
                    #{d.parent.number} {d.parent.subject}
                  </Link>
                </>
              )}
            </p>
            <h2 id="ticket-subject" className="mt-1 text-xl font-bold text-slate-900">
              {t.subject}
            </h2>
            {can && <TicketPresence number={t.number} className="mt-1.5" />}
            {vip?.vip &&<VipChip size="md" reason={vip.reason} className="mt-1.5" />}
            {(t.automated === 1 || t.source === "alert") && (
              <span className="mt-1.5 inline-flex">
                <AutomatedChip size="md" ticket={t} />
              </span>
            )}
            {isPortalTicket(t) && (
              <span className="mt-1.5 inline-flex">
                <OutsideCustomerChip size="md" ticket={t} />
              </span>
            )}
            <TicketCcRow
              number={t.number}
              state={people}
              meId={me.id}
              requesterId={t.requester_id}
              canEdit={can && !closed && (can$("tickets.reply_public") || can$("tickets.reply_needs_review"))}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {t.in_workflow && !closed && <span className={chipClass("accent")}>{HD_IN_WORKFLOW_LABEL}</span>}
            {can && can$("tickets.change_status") && !merged ? (
              <PickMenu
                label="Status"
                value={t.status}
                options={statusOptions}
                // Hang right from the pill: with Follow in the header the actions wrap at 1280px,
                // and an end-aligned menu then reached under the queue column (1.19.1).
                align="start"
                onPick={(s) => patch({ status: s }, `Status set to ${HD_STATUS_LABEL[s]}.`)}
                trigger={(p) => (
                  <button
                    {...p}
                    type="button"
                    disabled={busy}
                    data-tt="Status"
                    aria-label={`Status: ${HD_STATUS_LABEL[t.status]}`}
                    className={`inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full px-3 text-sm font-medium transition disabled:opacity-60 ${PILL_TONE[STATUS_TONE[t.status]]}`}
                  >
                    {HD_STATUS_LABEL[t.status]}
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              />
            ) : (
              <span className={chipClass(chip.tone)}>{chip.label}</span>
            )}
            {can && <FollowButton number={t.number} state={people} />}
            {can && !closed && can$("tickets.change_status") && (
              <Button variant="secondary" icon={<CircleCheck />} busy={busy} onClick={() => patch({ status: "solved" }, `#${t.number} solved.`)}>
                Solve
              </Button>
            )}
            {/* 1.19.2: the menu also carries the major incident actions (agent W1), so it decides itself whether to show. */}
            {can && (
              <TicketMoreMenu
                ticket={t}
                number={t.number}
                canDelete={can$("tickets.delete")}
                mergeFrom={canMergeFrom(t, can$) ? t : null}
                onMerged={(keep) => { void load(true); refreshQueue(); if (keep !== t.number) router.push(`/desk/tickets/${keep}${qs}`); }}
                onDeleted={() => { refreshQueue(); router.push(`/desk${qs}`); }}
              />
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 items-start gap-4 @2xl:grid-cols-[minmax(0,1fr)_15rem] @5xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex min-w-0 flex-col gap-3">
            <BlockedRunBanner detail={d} onChanged={() => void load(true).then(refreshQueue)} />
            <TaskOutcomeBar detail={d} onChanged={() => void load(true).then(refreshQueue)} />
            <MergedNotice d={d} />
            {/* A major incident's updates and linked tickets (1.19.2, agent W1). */}
            {can && <IncidentPanel number={t.number} refreshKey={t.updated_at} onChanged={() => void load(true).then(refreshQueue)} />}
            {/* Checklists (1.19.2, agent W3); refreshed as the timeline moves. */}
            {can && <TicketChecklists number={t.number} refreshKey={d.messages.length} />}
            <Conversation messages={d.messages} requesterId={t.requester_id} meId={me.id} ticketNumber={t.number} origins={d.merge?.message_origins} />
            {can && !merged && <ClaudeDraftCard number={t.number} onUse={(body) => composer.current?.fill(body)} />}
            {can && merged ? (
              <MergedComposerLock d={d} />
            ) : can ? (
              <Composer
                ref={composer}
                number={t.number}
                subject={t.subject}
                requesterName={t.requester_name}
                ccCount={people.people?.ccs.length ?? 0}
                agentName={me.name}
                suggestions={d.suggested_articles}
                onSent={afterSend}
                forReview={!can$("tickets.reply_public")}
                allowNotes={can$("tickets.internal_note")}
                defaultMode={t.automated === 1 ? "internal" : "public"}
                automated={t.automated === 1}
                latestMessageId={latestMessageId(d.messages)}
                onNewer={() => void load(true)}
              />
            ) : (
              <p className="notice-warn rounded-lg border px-3 py-2 text-sm">You can read this ticket but not work it: it belongs to a team you're not in.</p>
            )}
          </div>
          {/* The solve flow's "Log a maintenance record" dialog (1.19.3, assets/SolveMaintenance). */}
          <SolveMaintenanceHost />
          <SidePanel
            d={d}
            onPatch={patch}
            onInsertArticle={(title, url) => composer.current?.insertLink(title, url)}
            onReply={() => composer.current?.focus("public")}
            onReload={() => void load(true)}
          />
        </div>
      </article>
    </div>
  );
}

/** "Merge into another ticket…" (1.19.1): tickets.merge, and not already merged, closed, or part of a running workflow. */
function canMergeFrom(t: HdTicketDetail["ticket"], can$: (cap: string) => boolean): boolean {
  return can$("tickets.merge") && !t.merged_into && t.status !== "closed" && !t.in_workflow && !t.parent_ticket_id;
}

function TicketMoreMenu({
  ticket,
  number,
  onDeleted,
  canDelete = true,
  mergeFrom = null,
  onMerged,
}: {
  ticket: HdTicketDetail["ticket"];
  number: number;
  onDeleted: () => void;
  canDelete?: boolean;
  mergeFrom?: MergeCandidate | null;
  onMerged?: (keep: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const incident = useIncidentMenu(ticket);
  async function remove() {
    setOpen(false);
    const ok = await confirmDialog({
      title: `Delete ticket #${number}?`,
      body: "Its conversation, notes and attachments go with it, and the requester can no longer see it. This cannot be undone.",
      confirmLabel: "Delete ticket",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/tickets/${number}`, "DELETE", undefined, "Couldn't delete the ticket.");
      toast("ok", `Ticket #${number} deleted.`);
      onDeleted();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  if (!canDelete && !mergeFrom && !incident.any) return null;
  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ticket #${number}`}
        data-tt="More"
        className={iconButtonClass("bordered", "md")}
      >
        <MoreHorizontal aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label={`Ticket #${number}`} align="end" width="w-60">
        {incident.items(() => setOpen(false))}
        {incident.any && (mergeFrom || canDelete) && <MenuSeparator />}
        {mergeFrom && (
          <MenuItem icon={<GitMerge />} onClick={() => { setOpen(false); setMerging(true); }}>
            Merge into another ticket…
          </MenuItem>
        )}
        {mergeFrom && canDelete && <MenuSeparator />}
        {canDelete && (
          <MenuItem danger icon={<Trash2 />} onClick={remove}>
            Delete ticket…
          </MenuItem>
        )}
      </Popover>
      {mergeFrom && (
        <MergeDialog
          open={merging}
          onClose={() => setMerging(false)}
          tickets={[mergeFrom]}
          findOther
          onMerged={(keep) => { setMerging(false); onMerged?.(keep); }}
        />
      )}
      {incident.dialogs}
    </div>
  );
}

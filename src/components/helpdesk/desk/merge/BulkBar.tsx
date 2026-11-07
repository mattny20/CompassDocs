"use client";

// The queue's bulk bar (1.19.1, agent V2; mock-up #1). Shown under the
// list's header while rows are selected: a select-all checkbox and
// "{n} selected", then one menu per field the agent's desk role may change
// (Status, Priority, Team, Assignee, Tags: a control the role lacks is left
// out), Merge… for two or more, and Clear. Each choice is one POST
// /api/helpdesk/tickets/bulk; the server checks every ticket on its own, so
// the result toast says how many changed, and "See why" lists the ones
// skipped with their reasons (BulkSkippedDialog).

import { useEffect, useRef, useState } from "react";
import { ChevronDown, GitMerge, Tag, Trash2, X } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { MenuItem, Popover } from "@/components/Popover";
import { promptDialog } from "@/components/Dialog";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toasts";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_STATUSES, HD_STATUS_LABEL, type HdTicketListRow } from "@/lib/helpdesk/types";
import { MERGE_MAX, type HdBulkPatch, type HdBulkResult } from "@/lib/helpdesk/merge-shared";
import { getJson, listOf, sendJson } from "../api";
import { useDeskCounts } from "../counts";
import { useCan, useDeskMe } from "../me";
import { PickMenu } from "../PickMenu";
import { PRIORITY_DOT } from "../ui";
import { MergeDialog } from "./MergeDialog";
import type { RowSelection } from "./selection";
import { DeclareFromSelection } from "../incidents/IncidentActions";
import { DeleteTicketsDialog } from "../recycle-bin/DeleteTicketsDialog";
import { BIN_BULK_MAX } from "@/lib/helpdesk/recycle-bin-shared";

const MENU_BTN = buttonClass("secondary", "sm", "gap-1");

function menuTrigger(label: string, busy: boolean) {
  // eslint-disable-next-line react/display-name
  return (p: Record<string, unknown>) => (
    <button {...p} type="button" disabled={busy} className={MENU_BTN}>
      {label}
      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

interface Agent {
  user_id: number;
  name: string;
}

export function BulkBar({ selection, shown, onDone }: { selection: RowSelection; shown: number; onDone: () => void }) {
  const can = useCan();
  const me = useDeskMe();
  const { counts } = useDeskCounts();
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  // 1.19.4 (C7): Delete moves the selection to the recycle bin (mock-up v1).
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [skipped, setSkipped] = useState<{ row: HdTicketListRow | undefined; result: HdBulkResult }[] | null>(null);
  const tagsBtn = useRef<HTMLButtonElement>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const all = useRef<HTMLInputElement>(null);

  const n = selection.count;
  const rows = selection.rows;
  const bulk = can("tickets.bulk");
  const anyAssign = can("tickets.assign_any") || can("tickets.assign_team");
  const allShown = n > 0 && n === shown;
  const any = n > 0;

  useEffect(() => {
    // Loaded on the first selection, not with every queue.
    if (!bulk || agents || !any) return;
    let live = true;
    getJson("/api/helpdesk/agents")
      .then((r) => live && setAgents(listOf<Agent>(r, "agents")))
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [bulk, agents, any]);

  async function apply(patch: HdBulkPatch, what: string) {
    if (!n || busy) return;
    setBusy(true);
    try {
      const r = await sendJson<{ results: HdBulkResult[]; ok: number; skipped: number }>(
        "/api/helpdesk/tickets/bulk",
        "POST",
        { numbers: rows.map((t) => t.number), patch },
        "Couldn't change the tickets."
      );
      const bad = r.results.filter((x) => !x.ok);
      const changed = r.results.filter((x) => x.ok && (x.changed?.length ?? 0) > 0).length;
      const lead = changed === 1 ? `1 ticket ${what}.` : `${changed} tickets ${what}.`;
      if (bad.length) {
        const list = bad.map((result) => ({ result, row: rows.find((t) => t.number === result.number) }));
        toast(changed ? "ok" : "error", `${changed ? lead : "Nothing changed."} ${bad.length} skipped.`, {
          action: { label: "See why", onClick: () => setSkipped(list) },
        });
      } else toast("ok", changed ? lead : "Already as asked; nothing changed.");
      // A successful edit clears the selection; a fully refused one keeps it to try again.
      if (r.ok > 0) selection.clear();
      onDone();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function tags(mode: "add" | "remove") {
    setTagsOpen(false);
    const v = await promptDialog({
      title: mode === "add" ? `Add a tag to ${n} ticket${n === 1 ? "" : "s"}` : `Remove a tag from ${n} ticket${n === 1 ? "" : "s"}`,
      label: "Tag",
      help: mode === "add" ? "Short words that help you find and report on tickets: vpn, mfa, onboarding." : "Tickets without it are left as they are.",
      confirmLabel: mode === "add" ? "Add tag" : "Remove tag",
      validate: (s) => (/^[\p{L}\p{N} _-]{1,40}$/u.test(s.trim()) ? undefined : "Use up to 40 letters, numbers, spaces or dashes."),
    });
    if (!v) return;
    const tag = v.trim().toLowerCase();
    await apply(mode === "add" ? { add_tags: [tag] } : { remove_tags: [tag] }, mode === "add" ? `tagged ${tag}` : `untagged ${tag}`);
  }

  // Indeterminate while some, not all, rows are selected.
  useEffect(() => {
    if (all.current) all.current.indeterminate = n > 0 && !allShown;
  });

  const assigneeOptions = [
    { value: 0, label: "Unassigned" },
    { value: me.id, label: `${me.name || "Me"} (you)` },
    ...(anyAssign ? (agents ?? []).filter((a) => a.user_id !== me.id).map((a) => ({ value: a.user_id, label: a.name })) : []),
  ];

  // Mounted while rows can be selected, so "See why" still opens after a
  // successful edit cleared the selection; the bar itself shows only with one.
  const skippedDialog = <BulkSkippedDialog list={skipped} onClose={() => setSkipped(null)} />;
  if (n === 0) return skippedDialog;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-1.5 border-b border-compass-200 bg-compass-50/70 px-3 py-2 print:hidden"
    >
      <input
        ref={all}
        type="checkbox"
        checked={allShown}
        onChange={selection.toggleAll}
        aria-label={allShown ? "Clear the selection" : `Select all ${shown} shown tickets`}
        className="h-4 w-4 accent-compass-600"
      />
      <span className="mr-1 text-sm font-semibold text-compass-800" aria-live="polite">
        {n} selected
      </span>
      {bulk && can("tickets.change_status") && (
        <PickMenu
          label="Status"
          value={null}
          align="start"
          options={HD_STATUSES.filter((s) => s !== "new").map((s) => ({ value: s, label: HD_STATUS_LABEL[s] }))}
          onPick={(s) => apply({ status: s }, `set to ${HD_STATUS_LABEL[s]}`)}
          trigger={menuTrigger("Status", busy)}
        />
      )}
      {bulk && can("tickets.change_priority") && (
        <PickMenu
          label="Priority"
          value={null}
          align="start"
          options={HD_PRIORITIES.slice().reverse().map((p) => ({ value: p, label: HD_PRIORITY_LABEL[p], icon: <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[p]}`} /> }))}
          onPick={(p) => apply({ priority: p }, `set to ${HD_PRIORITY_LABEL[p]} priority`)}
          trigger={menuTrigger("Priority", busy)}
        />
      )}
      {bulk && can("tickets.transfer_team") && (counts?.teams.length ?? 0) > 0 && (
        <PickMenu
          label="Team"
          value={null}
          align="start"
          options={(counts?.teams ?? []).map((t) => ({ value: t.team_id, label: t.name }))}
          onPick={(id) => apply({ team_id: id }, `moved to ${counts?.teams.find((t) => t.team_id === id)?.name ?? "the team"}`)}
          trigger={menuTrigger("Team", busy)}
        />
      )}
      {bulk && (anyAssign || can("tickets.assign_self")) && (
        <PickMenu
          label="Assignee"
          value={null}
          align="start"
          options={assigneeOptions}
          onPick={(id) =>
            apply({ assignee_id: id === 0 ? null : id }, id === 0 ? "unassigned" : id === me.id ? "assigned to you" : `assigned to ${assigneeOptions.find((o) => o.value === id)?.label}`)
          }
          trigger={menuTrigger("Assignee", busy)}
        />
      )}
      {bulk && (
        <div className="relative">
          <button
            ref={tagsBtn}
            type="button"
            disabled={busy}
            onClick={() => setTagsOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={tagsOpen}
            className={MENU_BTN}
          >
            Tags
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <Popover open={tagsOpen} onClose={() => setTagsOpen(false)} triggerRef={tagsBtn} role="menu" label="Tags" align="start" width="w-48" className="mt-1">
            <MenuItem icon={<Tag />} onClick={() => void tags("add")}>
              Add a tag…
            </MenuItem>
            <MenuItem icon={<X />} onClick={() => void tags("remove")}>
              Remove a tag…
            </MenuItem>
          </Popover>
        </div>
      )}
      {can("tickets.merge") && n >= 2 && (
        <Button
          size="sm"
          icon={<GitMerge />}
          disabled={busy || n > MERGE_MAX}
          onClick={() => setMergeOpen(true)}
          data-tt={n > MERGE_MAX ? `Up to ${MERGE_MAX} tickets at a time.` : undefined}
        >
          Merge…
        </Button>
      )}
      {can("tickets.delete") && (
        <button
          type="button"
          disabled={busy || n > BIN_BULK_MAX}
          onClick={() => setDeleteOpen(true)}
          aria-label={`Delete ${n} selected ticket${n === 1 ? "" : "s"}`}
          data-tt={n > BIN_BULK_MAX ? `Up to ${BIN_BULK_MAX} tickets at a time.` : "Delete…"}
          className={buttonClass("secondary", "sm", "w-7 px-0 text-red-600 dark:text-red-400")}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
      {/* Declare a major incident linking the selection (1.19.2, agent W1). */}
      <DeclareFromSelection rows={rows} busy={busy} onDone={() => { selection.clear(); onDone(); }} />
      <Button variant="ghost" size="sm" icon={<X />} onClick={selection.clear}>
        Clear
      </Button>

      <DeleteTicketsDialog
        open={deleteOpen}
        tickets={rows.map((t) => ({ number: t.number, subject: t.subject }))}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          selection.clear();
          onDone();
        }}
        onRestored={onDone}
      />
      <MergeDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        tickets={rows}
        onMerged={() => {
          setMergeOpen(false);
          selection.clear();
          onDone();
        }}
      />
      {skippedDialog}
    </div>
  );
}

/** "N skipped · See why": each skipped ticket and the server's reason. */
export function BulkSkippedDialog({
  list,
  onClose,
}: {
  list: { row: HdTicketListRow | undefined; result: HdBulkResult }[] | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!list}
      onClose={onClose}
      labelledBy="bulk-skipped-title"
      className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <h2 id="bulk-skipped-title" className="text-base font-semibold text-slate-900">
        {list?.length === 1 ? "1 ticket skipped" : `${list?.length ?? 0} tickets skipped`}
      </h2>
      <p className="mt-1 text-sm text-slate-600">Bulk changes check each ticket separately. These weren&apos;t changed:</p>
      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {(list ?? []).map(({ row, result }) => (
          <li key={result.number} className="px-3 py-2">
            <span className="block truncate text-sm font-medium text-slate-800">
              #{result.number} {row?.subject ?? ""}
            </span>
            <span className="block text-xs text-slate-600">{result.error}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose} data-autofocus="">
          Close
        </Button>
      </div>
    </Modal>
  );
}

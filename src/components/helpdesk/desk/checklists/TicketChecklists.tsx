"use client";

// A ticket's checklists (1.19.2, agent W3; mock-up c1). Two views of one
// store, so either refreshes the other:
//
//   TicketChecklists     the main column, above the conversation: one card
//                        per checklist (the ListChecks eyebrow with its name,
//                        "4 of 7 done", Add an item and Remove, a progress
//                        bar, the items: a checkbox, the title struck through
//                        once done, a warn Required chip while open, and on
//                        the right who ticked it, or the owner team and due
//                        date), then one note: ticking is on the timeline and
//                        required items block solving.
//   ChecklistsSideCard   the side column: "Checklists", each one's name and
//                        n/total (a link to its card), and Add a checklist
//                        (a picker of the library's templates).
//
// revealChecklists(number) scrolls to the first checklist with a required
// item open and focuses that item: the desk calls it when a solve is refused
// for it. Agents only: the requester's side never loads any of this.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ListChecks, Plus, Trash2 } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EYEBROW_TEXT } from "@/components/Heading";
import { SectionEmpty } from "@/components/form";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { shortDate } from "@/lib/helpdesk/business-waits-shared";
import { CHECKLIST_LIMITS, type HdTicketChecklist, type HdTicketChecklistItem, type HdTicketChecklists } from "@/lib/helpdesk/checklists-shared";
import { getJson, sendJson } from "../api";
import { useCan } from "../me";
import { PickMenu } from "../PickMenu";

type Templates = { id: number; name: string; items: number; required: number }[];
type View = HdTicketChecklists & { templates: Templates; solve_block?: string | null };

// --- The store (one per ticket number) --------------------------------------------------

interface Entry {
  view: View | null;
  error: string;
  subs: Set<() => void>;
  loading: Promise<void> | null;
}

const stores = new Map<number, Entry>();

function entry(n: number): Entry {
  let e = stores.get(n);
  if (!e) {
    e = { view: null, error: "", subs: new Set(), loading: null };
    stores.set(n, e);
  }
  return e;
}

function publish(n: number, view: View | null, error = "") {
  const e = entry(n);
  e.view = view;
  e.error = error;
  for (const f of e.subs) f();
}

function reload(n: number): Promise<void> {
  const e = entry(n);
  if (e.loading) return e.loading;
  e.loading = getJson<View>(`/api/helpdesk/tickets/${n}/checklists`, "Couldn't load the checklists.")
    .then((v) => publish(n, v))
    .catch((err: Error) => publish(n, e.view, err.message))
    .finally(() => {
      e.loading = null;
    });
  return e.loading;
}

function useChecklists(n: number, refreshKey?: unknown) {
  const subscribe = useCallback(
    (f: () => void) => {
      const e = entry(n);
      e.subs.add(f);
      return () => e.subs.delete(f);
    },
    [n]
  );
  const view = useSyncExternalStore(subscribe, () => entry(n).view, () => null);
  const error = useSyncExternalStore(subscribe, () => entry(n).error, () => "");
  useEffect(() => {
    void reload(n);
  }, [n, refreshKey]);
  /** Send a change; the answer is the new view. */
  const send = useCallback(
    async (url: string, method: "POST" | "PATCH" | "DELETE", body: unknown, fallback: string): Promise<boolean> => {
      try {
        publish(n, await sendJson<View>(url, method, body, fallback));
        return true;
      } catch (e) {
        toast("error", (e as Error).message);
        void reload(n);
        return false;
      }
    },
    [n]
  );
  return { view, error, send };
}

/** Scroll to the first checklist with a required item open and focus that item. */
export function revealChecklists(n: number): void {
  void reload(n).then(() => {
    const v = entry(n).view;
    const c = v?.checklists.find((x) => x.required_open > 0);
    if (!c) return;
    const card = document.getElementById(`checklist-${c.id}`);
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
    const item = c.items.find((i) => i.required && !i.done);
    if (item) (document.getElementById(`checklist-item-${item.id}`) as HTMLInputElement | null)?.focus({ preventScroll: true });
  });
}

/**
 * Before anything a solve would do first (stop a timer, ask for time): would
 * required checklist items refuse it? Then say so, show them and answer
 * true. False when nothing blocks, or the lookup fails (the server decides).
 */
export async function checklistsHoldSolve(n: number): Promise<boolean> {
  try {
    const v = await getJson<View>(`/api/helpdesk/tickets/${n}/checklists`);
    publish(n, v);
    if (!v.solve_block) return false;
    toast("error", v.solve_block);
    revealChecklists(n);
    return true;
  } catch {
    return false;
  }
}

// --- Main column ----------------------------------------------------------------------

export function TicketChecklists({ number, refreshKey }: { number: number; refreshKey?: unknown }) {
  const { view, send } = useChecklists(number, refreshKey);
  const can$ = useCan();
  if (!view || view.checklists.length === 0) return null;
  const base = `/api/helpdesk/tickets/${number}/checklists`;
  const anyRequired = view.checklists.some((c) => c.items.some((i) => i.required));
  return (
    <div className="flex flex-col gap-3" data-testid="ticket-checklists">
      {view.checklists.map((c, idx) => (
        <ChecklistCard
          key={c.id}
          c={c}
          canEdit={view.can_edit}
          canRemove={view.can_remove && can$("tickets.change_status")}
          note={idx === view.checklists.length - 1}
          anyRequired={anyRequired}
          onTick={(item, done) => send(`${base}/items/${item.id}`, "PATCH", { done }, "Couldn't save that.")}
          onAddItem={async () => {
            const title = await promptDialog({
              title: `Add an item to ${c.name}`,
              label: "Item",
              help: "Just for this ticket. It isn't required.",
              confirmLabel: "Add item",
              validate: (v) => (v.trim().length > CHECKLIST_LIMITS.itemTitle ? `Keep it under ${CHECKLIST_LIMITS.itemTitle} characters.` : undefined),
            });
            if (title?.trim() && (await send(`${base}/${c.id}/items`, "POST", { title: title.trim() }, "Couldn't add the item."))) toast("ok", "Item added.");
          }}
          onRemove={async () => {
            const ok = await confirmDialog({
              title: `Remove ${c.name}?`,
              body:
                c.required_open > 0
                  ? `It has ${c.required_open} required ${c.required_open === 1 ? "item" : "items"} not done yet. The timeline keeps a note that it was removed.`
                  : "The timeline keeps a note that it was removed.",
              confirmLabel: "Remove checklist",
              danger: true,
            });
            if (ok === true && (await send(`${base}/${c.id}`, "DELETE", undefined, "Couldn't remove the checklist."))) toast("ok", "Checklist removed.");
          }}
        />
      ))}
    </div>
  );
}

function ChecklistCard({
  c,
  canEdit,
  canRemove,
  note,
  anyRequired,
  onTick,
  onAddItem,
  onRemove,
}: {
  c: HdTicketChecklist;
  canEdit: boolean;
  canRemove: boolean;
  note: boolean;
  anyRequired: boolean;
  onTick: (item: HdTicketChecklistItem, done: boolean) => Promise<boolean>;
  onAddItem: () => void;
  onRemove: () => void;
}) {
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const headingId = `checklist-${c.id}-h`;
  return (
    <section id={`checklist-${c.id}`} aria-labelledby={headingId} className={`${CARD_CLASS} scroll-mt-4 px-4 py-3.5 sm:px-5`}>
      <div className="flex items-center gap-2">
        <h3 id={headingId} className={`${EYEBROW_TEXT} inline-flex min-w-0 items-center gap-1.5`}>
          <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{c.name}</span>
        </h3>
        <span className="ml-1 shrink-0 text-sm text-slate-500">
          {c.done} of {c.total} done
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 print:hidden">
          {canEdit && (
            <button type="button" onClick={onAddItem} aria-label={`Add an item to ${c.name}`} data-tt="Add an item" className={iconButtonClass("quiet", "sm")}>
              <Plus aria-hidden />
            </button>
          )}
          {canRemove && (
            <button type="button" onClick={onRemove} aria-label={`Remove ${c.name}`} data-tt="Remove checklist" className={iconButtonClass("quiet", "sm", "hover-danger")}>
              <Trash2 aria-hidden />
            </button>
          )}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${c.name} progress`}
        aria-valuemin={0}
        aria-valuemax={c.total}
        aria-valuenow={c.done}
        aria-valuetext={`${c.done} of ${c.total} done`}
        className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100"
      >
        <div className="h-full rounded-full bg-compass-600 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-2" aria-label={`${c.name} items`}>
        {c.items.map((it) => (
          <ItemRow key={it.id} it={it} canEdit={canEdit} onTick={onTick} />
        ))}
      </ul>
      {note && (
        <p className="mt-2.5 text-xs text-slate-500">
          Ticking an item is noted on the timeline.{anyRequired ? " Required items must be done before the ticket can be solved." : ""}
        </p>
      )}
    </section>
  );
}

function ItemRow({ it, canEdit, onTick }: { it: HdTicketChecklistItem; canEdit: boolean; onTick: (item: HdTicketChecklistItem, done: boolean) => Promise<boolean> }) {
  // Optimistic: the box shows the new state at once; a refusal puts it back.
  const [pending, setPending] = useState<boolean | null>(null);
  const busy = pending !== null;
  const overdue = !it.done && !!it.due_at && Date.parse(it.due_at) < Date.now();
  const meta = it.done
    ? it.done_by_name
    : [it.team_name, it.due_date ? `due ${shortDate(it.due_date)}` : ""].filter(Boolean).join(" · ");
  const id = `checklist-item-${it.id}`;
  return (
    <li className="flex items-start gap-3 border-b border-slate-100 py-2 last:border-b-0">
      <input
        id={id}
        type="checkbox"
        checked={pending ?? it.done}
        disabled={!canEdit}
        aria-busy={busy || undefined}
        onChange={async (e) => {
          if (busy) return;
          setPending(e.target.checked);
          await onTick(it, e.target.checked);
          setPending(null);
        }}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-compass-600 disabled:cursor-default"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <label htmlFor={id} className={`min-w-0 flex-1 basis-56 text-sm ${it.done ? "text-slate-500 line-through" : "text-slate-800"} ${canEdit ? "cursor-pointer" : ""}`}>
          {it.title}
          {it.required && !it.done && <span className={`${chipClass("warn", "sm")} ml-2 align-middle no-underline`}>Required</span>}
          {it.done && <span className="sr-only"> (done)</span>}
        </label>
        {meta && (
          <span className={`shrink-0 text-xs ${overdue ? "font-medium ink-warn" : "text-slate-500"}`}>
            {meta}
            {overdue && <span className="sr-only"> (overdue)</span>}
          </span>
        )}
      </div>
    </li>
  );
}

// --- Side column ----------------------------------------------------------------------

export function ChecklistsSideCard({ number, canWork }: { number: number; canWork: boolean }) {
  const { view, error, send } = useChecklists(number);
  const can$ = useCan();
  if (!canWork || !view) return null;
  if (!view.can_edit && view.checklists.length === 0) return null;
  const onTicket = new Set(view.checklists.map((c) => c.name));
  const options = view.templates.map((t) => ({
    value: t.id,
    label: t.name,
    hint: `${t.items} ${t.items === 1 ? "item" : "items"}${t.required ? ` · ${t.required} required` : ""}${onTicket.has(t.name) ? " · on this ticket" : ""}`,
  }));
  const mayManage = can$("settings.manage") || can$("request_types.manage") || can$("workflows.manage");
  return (
    <section aria-labelledby={`checklists-side-${number}`} className={`${CARD_CLASS} px-4 py-3.5`} data-testid="checklists-side">
      <h3 id={`checklists-side-${number}`} className={EYEBROW_TEXT}>
        Checklists
      </h3>
      {error && !view && <p className="mt-2 text-sm ink-warn">{error}</p>}
      {view.checklists.length > 0 && (
        <ul className="mt-1.5">
          {view.checklists.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-b-0">
              <a href={`#checklist-${c.id}`} className="min-w-0 truncate text-sm text-slate-800 hover:underline">
                {c.name}
              </a>
              <span className={`shrink-0 text-sm font-bold tabular-nums ${c.required_open ? "ink-warn" : "text-slate-900"}`}>
                {c.done}/{c.total}
                {c.required_open > 0 && <span className="sr-only"> ({c.required_open} required to do)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {view.can_edit &&
        (view.templates.length === 0 ? (
          <SectionEmpty className="mt-2" action={mayManage ? { href: "/desk/settings/checklists", label: "Set one up" } : undefined}>
            No checklists in the library yet.
          </SectionEmpty>
        ) : (
          <PickMenu
            label="Add a checklist"
            value={null}
            options={options}
            align="end"
            width="w-72"
            onPick={async (id) => {
              if (await send(`/api/helpdesk/tickets/${number}/checklists`, "POST", { template_id: id }, "Couldn't add the checklist.")) {
                toast("ok", "Checklist added.");
                setTimeout(() => {
                  const v = entry(number).view;
                  const last = v?.checklists[v.checklists.length - 1];
                  if (last) document.getElementById(`checklist-${last.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                }, 50);
              }
            }}
            trigger={(p) => (
              <button {...p} type="button" className={buttonClass("secondary", "md", "mt-2.5 w-full justify-center [&>svg]:h-4 [&>svg]:w-4")}>
                <Plus aria-hidden />
                Add a checklist
              </button>
            )}
          />
        ))}
    </section>
  );
}

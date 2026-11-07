"use client";

// /desk and /desk/tickets/[number]: the split view. Three panes side by
// side on a desktop (views and teams, the ticket list, the open ticket),
// so the list stays in view while a ticket is worked. Narrower, the views
// fold into the list's title menu (under xl) and the list and the ticket
// stack (under lg): a ticket fills the page with a link back to its list.
//
// Keyboard (single-key shortcuts, hotkeys.ts): j / k walk the list, Enter
// opens the row under focus. The ticket's own keys live in TicketPane.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDownUp, ChevronDown, Filter, MessageSquareText, Plus } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { useCan } from "../me";
import { iconButtonClass } from "@/components/Button";
import { railIconClass, railRowClass, RAIL_GROUP_TEXT } from "@/components/RailLink";
import { Popover } from "@/components/Popover";
import type { HdTicketListRow } from "@/lib/helpdesk/types";
import { getJson, listOf } from "../api";
import { useDeskCounts } from "../counts";
import { useDeskKeys } from "../hotkeys";
import { PickMenu } from "../PickMenu";
import { TeamIcon } from "../TeamIcon";
import { TicketList } from "./TicketList";
import { BulkBar } from "../merge/BulkBar";
import { useRowSelection } from "../merge/selection";
import { NewTicketModal } from "./NewTicketModal";
import { SORTS, VIEWS, apiQs, readSel, selQs, type QueueSel } from "./views";
import { savedApiQs, useSavedViews } from "../views/saved";
import { SavedViewsNav } from "../views/SavedViewsNav";
import { EditViewButton, SaveViewButton } from "../views/ViewControls";
import { ViewDialogs } from "../views/ViewDialogs";
import { IncidentsNav } from "../incidents/IncidentsNav";
import { TeamStatusBanner } from "../team-status/TeamStatusBanner";
import { RecycleBinNav } from "../recycle-bin/RecycleBinNav";
import { filterSummary } from "@/lib/helpdesk/saved-views-shared";

interface QueueCtx {
  rows: HdTicketListRow[] | null;
  qs: string;
  sel: QueueSel;
  /** Reload the list and the counts (after a change to a ticket). */
  refresh: () => void;
  title: string;
}

const Ctx = createContext<QueueCtx>({ rows: null, qs: "", sel: { view: "mine", team: null, sort: "due", drill: null }, refresh: () => {}, title: "My open" });
export const useQueue = () => useContext(Ctx);

export function QueueLayout({ children }: { children: ReactNode }) {
  const sp = useSearchParams();
  const params = useParams<{ number?: string }>();
  const router = useRouter();
  const sel = useMemo(() => readSel(sp), [sp]);
  const qs = selQs(sel);
  const selected = params?.number ? Number(params.number) : null;
  // 1.19.4 (C7): /desk/recycle-bin pages bring their own list; the queue's list column stays out.
  const binPage = (usePathname() ?? "").startsWith("/desk/recycle-bin");
  const { counts, refresh: refreshCounts } = useDeskCounts();
  const [rows, setRows] = useState<HdTicketListRow[] | null>(null);
  const [error, setError] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 1.19.1 saved views (agent V4, ../views): ?saved=12 lists the view's own filters.
  const sv = useSavedViews();
  const savedView = sel.saved ? sv.list?.views.find((v) => v.id === sel.saved) : undefined;
  const listQs = sel.saved ? savedApiQs(sel, sv.list?.views) : apiQs(sel);
  const savedGone = !!sel.saved && !!sv.list && !listQs;

  const load = useCallback(() => {
    if (!listQs) {
      if (savedGone) setError("This saved view was deleted, or it isn't shared with you any more.");
      return;
    }
    getJson(`/api/helpdesk/tickets?${listQs}`, "Couldn't load the tickets.")
      .then((d) => {
        setRows(listOf<HdTicketListRow>(d, "tickets", "rows"));
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, [listQs, savedGone]);

  useEffect(() => {
    setRows(null);
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const refreshViews = sv.refresh;
  const refresh = useCallback(() => {
    load();
    refreshCounts();
    refreshViews();
  }, [load, refreshCounts, refreshViews]);

  const can = useCan();
  // Replies from newbies waiting for a lead (agent J's review queue), in the counts.
  const reviewer = can("replies.review");
  const reviews = reviewer ? counts?.reviews_pending ?? 0 : 0;
  const team = sel.team ? counts?.teams.find((t) => t.team_id === sel.team) : null;
  const title = sel.saved ? savedView?.name ?? "Saved view" : sel.drill && sel.origin === "filter" ? "Filtered tickets" : sel.drill ? "Report drill-down" : sel.team ? team?.name ?? "Team" : VIEWS.find((v) => v.key === sel.view)?.label ?? "My open";

  // j / k move focus through the list's rows; Enter (on a focused row) is
  // the link's own. Focus is real, so the outline shows where you are.
  const move = (dir: 1 | -1) => {
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-row]") ?? []);
    if (!links.length) return;
    const cur = links.findIndex((a) => a === document.activeElement);
    const sel = links.findIndex((a) => a.getAttribute("aria-current") === "page");
    const from = cur >= 0 ? cur : sel;
    const next = from < 0 ? 0 : Math.max(0, Math.min(links.length - 1, from + dir));
    links[next].focus();
    links[next].scrollIntoView({ block: "nearest" });
  };
  // Row selection and the bulk bar (1.19.1, agent V2, ../merge): x toggles the focused row.
  const selectable = can("tickets.bulk") || can("tickets.merge") || can("tickets.delete"); // 1.19.4: bulk delete (C7)
  const selection = useRowSelection(rows);
  useDeskKeys({
    j: () => move(1),
    k: () => move(-1),
    ...(selectable ? { x: () => selection.toggleFocused(listRef) } : {}),
    Enter: () => {
      const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-row]") ?? []);
      const first = links[0];
      if (!selected && first) router.push(first.getAttribute("href") || "/desk");
    },
  });

  const viewLinks = (onPick?: () => void, asMenu = false) => (
    <>
      <p className={`${RAIL_GROUP_TEXT} mb-1 mt-1 px-3`}>Views</p>
      {VIEWS.map((v) => {
        const on = !binPage && !sel.drill && !sel.team && sel.view === v.key;
        const n = counts?.views?.[v.key];
        const Icon = v.icon;
        return (
          <Link
            key={v.key}
            href={`/desk${selQs({ ...sel, drill: null, team: null, view: v.key })}`}
            onClick={onPick}
            role={asMenu ? "menuitem" : undefined}
            aria-current={on ? "page" : undefined}
            className={railRowClass(on)}
          >
            <Icon className={`h-4 w-4 ${railIconClass(on)}`} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{v.label}</span>
            {n !== undefined && (
              <span className={`text-xs tabular-nums ${v.alarm && n > 0 ? "font-semibold text-red-600" : "text-slate-500"}`}>
                {n}
                <span className="sr-only"> tickets</span>
              </span>
            )}
          </Link>
        );
      })}
      {reviewer && (
        <Link
          href="/desk/reviews"
          onClick={onPick}
          role={asMenu ? "menuitem" : undefined}
          className={railRowClass(false)}
        >
          <MessageSquareText className={`h-4 w-4 ${railIconClass(false)}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate">Reviews</span>
          {reviews > 0 && (
            <span className={chipClass("accent", "sm")}>
              {reviews}
              <span className="sr-only"> replies to review</span>
            </span>
          )}
        </Link>
      )}
      <SavedViewsNav sv={sv} sel={sel} onPick={onPick} asMenu={asMenu} />
      {/* Open major incidents (1.19.2, agent W1, ../incidents). */}
      <IncidentsNav selected={selected} qs={qs} onPick={onPick} asMenu={asMenu} />
      {/* The recycle bin (1.19.4, area C7, ../recycle-bin): tickets.delete only. */}
      <RecycleBinNav refreshKey={counts} onPick={onPick} asMenu={asMenu} />
      {counts && counts.teams.length > 0 && (
        <>
          <p className={`${RAIL_GROUP_TEXT} mb-1 mt-4 px-3`}>Teams</p>
          {counts.teams.map((t) => {
            const on = !binPage && !sel.drill && sel.team === t.team_id;
            return (
              <Link
                key={t.team_id}
                href={`/desk${selQs({ ...sel, drill: null, view: null, team: t.team_id })}`}
                onClick={onPick}
                role={asMenu ? "menuitem" : undefined}
                aria-current={on ? "page" : undefined}
                className={railRowClass(on)}
              >
                <span className={railIconClass(on)}>
                  <TeamIcon name={t.icon} />
                </span>
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="text-xs tabular-nums text-slate-500">
                  {t.open}
                  <span className="sr-only"> open tickets</span>
                </span>
              </Link>
            );
          })}
        </>
      )}
    </>
  );

  return (
    <Ctx.Provider value={{ rows, qs, sel, refresh, title }}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <nav aria-label="Ticket views" className="hidden w-rail shrink-0 overflow-y-auto border-r border-slate-200 px-2 py-3 xl:block">
          {viewLinks()}
        </nav>
        <section
          aria-labelledby="queue-title"
          className={`min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-surface lg:w-[23rem] ${binPage ? "hidden" : selected ? "hidden lg:flex" : "flex lg:flex"}`}
        >
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-slate-200 px-3">
            <QueueTitle title={title} count={rows?.length} viewLinks={viewLinks} />
            <div className="ml-auto flex items-center gap-1">
              <EditViewButton sv={sv} sel={sel} />
              <PickMenu
                label="Sort"
                value={sel.sort}
                options={SORTS}
                onPick={(sort) => router.push(`${selected ? `/desk/tickets/${selected}` : "/desk"}${selQs({ ...sel, sort })}`)}
                trigger={(p) => (
                  <button
                    {...p}
                    type="button"
                    aria-label={`Sort: ${SORTS.find((s) => s.value === sel.sort)?.label}`}
                    className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    <ArrowDownUp className="h-3.5 w-3.5 sm:hidden" aria-hidden />
                    <span className="hidden sm:inline">{SORTS.find((s) => s.value === sel.sort)?.label}</span>
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              />
              <button
                type="button"
                onClick={() => setNewOpen(true)}
                data-tt="New ticket"
                aria-label="New ticket"
                className={iconButtonClass("quiet", "sm")}
              >
                <Plus aria-hidden />
              </button>
            </div>
          </div>
          {sel.drill && (
            <div className="flex items-center gap-2 border-b border-compass-200 bg-compass-50/70 px-3 py-2 text-xs text-slate-700">
              <Filter className="h-3.5 w-3.5 shrink-0 text-compass-600" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {sel.origin === "filter" ? (
                  <>
                    Filtered: <span className="font-medium">{filterSummary(sel.drill, counts?.teams ?? [])}</span>
                  </>
                ) : (
                  <>
                    Filtered from Reports: <span className="font-medium">{drillSummary(sel.drill, counts?.teams ?? [])}</span>
                  </>
                )}
              </span>
              <SaveViewButton sv={sv} sel={sel} />
              <Link href="/desk" className="link shrink-0 font-medium">
                Clear
              </Link>
            </div>
          )}
          {/* A followed Status page service in trouble (1.19.2, agent W6, ../team-status). */}
          {sel.team && !sel.drill && <TeamStatusBanner teamId={sel.team} />}
          {selectable && <BulkBar selection={selection} shown={rows?.length ?? 0} onDone={refresh} />}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            <TicketList rows={rows} error={error} selected={selected} qs={qs} onRetry={load} title={title} selection={selectable ? selection : undefined} />
          </div>
        </section>
        <div className={`min-h-0 min-w-0 flex-1 ${selected || binPage ? "flex" : "hidden lg:flex"}`}>{children}</div>
      </div>
      <NewTicketModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={(n) => { setNewOpen(false); refresh(); router.push(`/desk/tickets/${n}${qs}`); }} />
      <ViewDialogs sv={sv} sel={sel} teams={counts?.teams ?? []} title={title} basePath={selected ? `/desk/tickets/${selected}` : "/desk"} />
    </Ctx.Provider>
  );
}

/** The list's title: plain under xl it opens the views menu (the views column is folded). */
function QueueTitle({
  title,
  count,
  viewLinks,
}: {
  title: string;
  count: number | undefined;
  viewLinks: (onPick?: () => void, asMenu?: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative flex min-w-0 items-center gap-2">
      <h2 id="queue-title" className="hidden min-w-0 items-baseline gap-2 text-base font-semibold text-slate-900 xl:flex">
        <span className="truncate">{title}</span>
        {count !== undefined && <span className="text-xs font-normal text-slate-500">{count}<span className="sr-only"> tickets</span></span>}
      </h2>
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-base font-semibold text-slate-900 hover:bg-slate-100 xl:hidden"
      >
        <span className="truncate">{title}</span>
        {count !== undefined && <span className="text-xs font-normal text-slate-500">{count}<span className="sr-only"> tickets</span></span>}
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <span className="sr-only">, change view</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Ticket views" width="w-64" className="mt-1 max-h-[70vh] overflow-y-auto xl:hidden">
        {viewLinks(() => setOpen(false), true)}
      </Popover>
    </div>
  );
}

const DRILL_LABEL: Record<string, string> = {
  assignee: "owner",
  priority: "priority",
  request_type: "request type",
  channel: "channel",
  status: "status",
  tag: "tag",
  created_from: "created from",
  created_to: "created to",
  solved_from: "solved from",
  solved_to: "solved to",
  requester: "requester",
  requester_email: "requester",
  category: "category",
  department: "department",
  office: "office",
};

/** "IT · priority high · created from 2026-10-01" for the drill-down bar. */
function drillSummary(d: Record<string, string>, teams: { team_id: number; name: string }[]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === "team") parts.push(teams.find((t) => String(t.team_id) === v)?.name ?? `team ${v}`);
    else if (k === "breached") parts.push(v === "now" ? "past a target now" : "missed a target");
    else if (k === "origin") parts.push(v === "automated" ? "automated only" : "people only");
    else if (k === "status_group") parts.push("open");
    else if (k === "vip") parts.push(v === "yes" ? "VIP requesters" : "not VIP requesters");
    else if (k === "integration") parts.push(v === "none" ? "no integration" : `integration ${v}`);
    else parts.push(`${DRILL_LABEL[k] ?? k} ${v.replace(/_/g, " ")}`);
  }
  return parts.join(" · ") || "all tickets";
}

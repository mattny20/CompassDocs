"use client";

// The saved views in the queue's views column (1.19.1, agent V4; mock-up 1):
// "My views" with a + (save the current list) and one "<Team> views" group
// per team that has any, each row a house rail link with its count. A view
// you may change has a row menu (Rename, Edit filters, Use the current
// list, Delete) on a "…" button that shows on hover and on keyboard focus.
// Folded into the list title's menu (under xl) the rows are plain menu
// items; saving and editing live on the list's own controls there.

import { useRef, useState } from "react";
import Link from "next/link";
import { Bookmark, Filter, ListRestart, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { SectionEmpty } from "@/components/form";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { railIconClass, railRowClass, RAIL_GROUP_TEXT } from "@/components/RailLink";
import type { HdSavedView } from "@/lib/helpdesk/saved-views-shared";
import { selQs, type QueueSel } from "../queue/views";
import { filtersFromSel, type SavedViews } from "./saved";

export function SavedViewsNav({
  sv,
  sel,
  onPick,
  asMenu = false,
}: {
  sv: SavedViews;
  sel: QueueSel;
  onPick?: () => void;
  asMenu?: boolean;
}) {
  const views = sv.list?.views ?? [];
  const mine = views.filter((v) => v.owner_id != null);
  const teams: { id: number; name: string; views: HdSavedView[] }[] = [];
  for (const v of views) {
    if (v.team_id == null) continue;
    let g = teams.find((t) => t.id === v.team_id);
    if (!g) teams.push((g = { id: v.team_id, name: v.team_name ?? "Team", views: [] }));
    g.views.push(v);
  }
  const row = (v: HdSavedView) => <ViewRow key={v.id} v={v} sv={sv} sel={sel} onPick={onPick} asMenu={asMenu} />;

  return (
    <div data-testid="saved-views-nav">
      <div className="mb-1 mt-4 flex items-center px-3">
        <p className={RAIL_GROUP_TEXT}>My views</p>
        {!asMenu && (
          <button
            type="button"
            onClick={() => sv.setDialog({ kind: "save", filters: filtersFromSel(sel, views) })}
            aria-label="Save this list as a view"
            data-tt="Save this list as a view"
            className={iconButtonClass("quiet", "sm", "-my-1 -mr-2 ml-auto")}
          >
            <Plus aria-hidden />
          </button>
        )}
      </div>
      {mine.length === 0 && !asMenu && sv.list && (
        <SectionEmpty className="px-3 pb-1" action={{ label: "Save this list", onClick: () => sv.setDialog({ kind: "save", filters: filtersFromSel(sel, views) }) }}>
          No saved views yet.
        </SectionEmpty>
      )}
      {mine.map(row)}
      {teams.map((t) => (
        <div key={t.id}>
          <p className={`${RAIL_GROUP_TEXT} mb-1 mt-4 truncate px-3`}>{t.name} views</p>
          {t.views.map(row)}
        </div>
      ))}
    </div>
  );
}

function ViewRow({ v, sv, sel, onPick, asMenu }: { v: HdSavedView; sv: SavedViews; sel: QueueSel; onPick?: () => void; asMenu: boolean }) {
  const on = sel.saved === v.id && !sel.view && !sel.team && !sel.drill;
  const menu = v.can_edit && !asMenu;
  return (
    <div className="group relative">
      <Link
        href={`/desk${selQs({ view: null, team: null, drill: null, saved: v.id, sort: sel.sort })}`}
        onClick={onPick}
        role={asMenu ? "menuitem" : undefined}
        aria-current={on ? "page" : undefined}
        className={railRowClass(on)}
        data-view-id={v.id}
      >
        <Bookmark className={`h-4 w-4 ${railIconClass(on)}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{v.name}</span>
        {v.count != null && (
          <span className={`text-xs tabular-nums text-slate-500 ${menu ? "group-focus-within:invisible group-hover:invisible" : ""}`}>
            {v.count}
            <span className="sr-only"> tickets</span>
          </span>
        )}
      </Link>
      {menu && <ViewRowMenu v={v} sv={sv} sel={sel} />}
    </div>
  );
}

function ViewRowMenu({ v, sv, sel }: { v: HdSavedView; sv: SavedViews; sel: QueueSel }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const current = filtersFromSel(sel, sv.list?.views);
  const same = sel.saved === v.id || JSON.stringify(sortKeys(current)) === JSON.stringify(sortKeys(v.filters));
  return (
    <div className={`absolute inset-y-0 right-1 my-auto flex h-7 items-center ${open ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for the view ${v.name}`}
        data-tt="View actions"
        className={iconButtonClass("quiet", "sm")}
      >
        <MoreHorizontal aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label={`View ${v.name}`} align="end" width="w-48">
        <MenuItem
          icon={<Pencil />}
          onClick={() => {
            setOpen(false);
            sv.setDialog({ kind: "rename", view: v });
          }}
        >
          Rename…
        </MenuItem>
        <MenuItem
          icon={<Filter />}
          onClick={() => {
            setOpen(false);
            sv.setDialog({ kind: "filter", filters: { ...v.filters }, view: v });
          }}
        >
          Edit filters…
        </MenuItem>
        {!same && (
          <MenuItem
            icon={<ListRestart />}
            onClick={() => {
              setOpen(false);
              void sv.setFilters(v, current);
            }}
          >
            Use the current list
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          danger
          icon={<Trash2 />}
          onClick={() => {
            setOpen(false);
            void sv.remove(v);
          }}
        >
          Delete…
        </MenuItem>
      </Popover>
    </div>
  );
}

function sortKeys(f: Record<string, string>): [string, string][] {
  return Object.entries(f).sort(([a], [b]) => a.localeCompare(b));
}

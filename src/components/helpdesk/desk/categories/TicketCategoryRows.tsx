"use client";

// The ticket side panel's Category and Sub-category rows (1.20.6): each a
// picker menu over the desk admin's list (lib/helpdesk/categories), so a
// change is one click and one PATCH, like Priority, Team and Owner. Nothing
// is typed. The Sub-category row shows while the ticket's category has
// sub-categories (or the ticket has one). An archived value the ticket
// already has stays shown, marked, until someone picks another.
// STYLEGUIDE §Helpdesk: categories.

import Link from "next/link";
import { ChevronDown, Settings } from "lucide-react";
import { SectionEmpty } from "@/components/form";
import { MenuSeparator } from "@/components/Popover";
import { findCategory } from "@/lib/helpdesk/categories-shared";
import type { HdTicketPatch } from "@/lib/helpdesk/types";
import { PickMenu, type PickOption } from "../PickMenu";
import { CATEGORIES_SETTINGS_HREF, pickable, useDeskCategories } from "./categories";

const NONE = "\u0000none";

export function TicketCategoryRows({
  category,
  subcategory,
  can,
  onPatch,
  rowClass,
  valueClass,
}: {
  category: string;
  subcategory: string;
  /** The viewer may change the ticket. */
  can: boolean;
  onPatch: (patch: HdTicketPatch, ok?: string) => void;
  /** The properties card's row and value-button recipes (SidePanel's ROW and VALUE_BTN). */
  rowClass: string;
  valueClass: string;
}) {
  const { list, canManage } = useDeskCategories();
  const loaded = list !== null;
  const offered = pickable(list);
  const current = findCategory(list ?? [], category);
  const subs = current ? current.subcategories.filter((s) => !s.archived) : [];

  const categoryOptions: PickOption<string>[] = [
    { value: NONE, label: "None" },
    ...offered.map((c) => ({
      value: c.name,
      label: c.name,
      hint: c.subcategories.length ? `${c.subcategories.length} ${c.subcategories.length === 1 ? "sub-category" : "sub-categories"}` : undefined,
    })),
    // What the ticket has, when pickers no longer offer it.
    ...(category && !findCategory(offered, category) ? [{ value: category, label: category, hint: !loaded ? undefined : current?.archived ? "Archived" : "Not on the list" }] : []),
  ];
  const subOptions: PickOption<string>[] = [
    { value: NONE, label: "None" },
    ...subs.map((s) => ({ value: s.name, label: s.name })),
    ...(subcategory && !findCategory(subs, subcategory) ? [{ value: subcategory, label: subcategory, hint: loaded ? "Archived" : undefined }] : []),
  ];
  const noneYet = loaded && offered.length === 0;

  const manage = (close: () => void, text?: string) => (
    <>
      {text && <SectionEmpty className="px-2 py-1.5">{text}</SectionEmpty>}
      {canManage && (
        <>
          {!text && <MenuSeparator />}
          <Link
            href={CATEGORIES_SETTINGS_HREF}
            role="menuitem"
            onClick={close}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <Settings className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            {noneYet ? "Add categories" : "Manage categories"}
          </Link>
        </>
      )}
    </>
  );

  return (
    <>
      <div className={rowClass}>
        <span className="text-sm text-slate-500">Category</span>
        <PickMenu
          label="Category"
          value={category || NONE}
          options={noneYet && !category ? [] : categoryOptions}
          onPick={(v) => (v === NONE ? onPatch({ category: "" }, "Category cleared.") : onPatch({ category: v }, `Category set to ${v}.`))}
          footer={(close) => manage(close, noneYet ? (canManage ? "No categories yet." : "No categories yet. An admin adds them in Desk settings.") : undefined)}
          trigger={(p) => (
            <button {...p} type="button" disabled={!can} aria-label={`Category: ${category || "None"}`} className={valueClass} data-testid="ticket-category">
              <span className="truncate">{category || "None"}</span>
              {can && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
            </button>
          )}
        />
      </div>
      {category && (subs.length > 0 || subcategory) && (
        <div className={rowClass}>
          <span className="shrink-0 text-sm text-slate-500">Sub-category</span>
          <PickMenu
            label="Sub-category"
            value={subcategory || NONE}
            options={subOptions}
            onPick={(v) => (v === NONE ? onPatch({ subcategory: "" }, "Sub-category cleared.") : onPatch({ subcategory: v }, `Sub-category set to ${v}.`))}
            trigger={(p) => (
              <button {...p} type="button" disabled={!can} aria-label={`Sub-category: ${subcategory || "None"}`} className={valueClass} data-testid="ticket-subcategory">
                <span className="truncate">{subcategory || "None"}</span>
                {can && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
              </button>
            )}
          />
        </div>
      )}
    </>
  );
}

"use client";

// Desk settings → Categories (1.20.6, lib/helpdesk/categories): the list of
// categories agents pick on a ticket, each with its sub-categories. One card
// of rows; every change acts at once (a toast, then the list reloads), so
// the page has no Save row. Per row: add a sub-category, rename, and a More
// menu (Move up, Move down, Archive or Restore, Merge into…, Delete).
//   - Rename renames it on the tickets, request types and rules that have it.
//   - Archive hides it from pickers; tickets that have it keep it.
//   - Delete is for an entry nothing uses; one that is used offers Merge.
//   - Merge into… moves everything to another entry (CategoryMergeDialog).
// STYLEGUIDE §Helpdesk: categories.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Folder, FolderTree, GitMerge, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { CARD_CLASS } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, SectionEmpty } from "@/components/form";
import { ListFilter } from "@/components/ListFilter";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { LoadingRow } from "@/components/Spinner";
import { Tooltip } from "@/components/Tooltip";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import {
  CATEGORY_LIMITS,
  categoryInUse,
  categoryKey,
  categoryNameProblem,
  categoryUseLine,
  cleanCategoryName,
  type HdCategoryAdmin,
  type HdCategoryUse,
  type HdSubcategoryAdmin,
} from "@/lib/helpdesk/categories-shared";
import { getJson, sendJson } from "../api";
import { forgetDeskCategories } from "./categories";
import { CategoryMergeDialog, type MergeSource } from "./CategoryMergeDialog";

const API = "/api/helpdesk/admin/categories";
const tickets = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "ticket" : "tickets"}`;

/** One row's entry, with the category it sits under when it is a sub-category. */
interface Entry {
  id: number;
  name: string;
  archived: boolean;
  use: HdCategoryUse;
  parent: HdCategoryAdmin | null;
  /** A category's sub-categories (for the delete sentence). */
  children: number;
}

export function CategoriesSettings() {
  const [list, setList] = useState<HdCategoryAdmin[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [merge, setMerge] = useState<MergeSource | null>(null);

  const reload = useCallback(() => {
    getJson<{ categories: HdCategoryAdmin[] }>(API, "Couldn't load the categories.")
      .then((d) => {
        setList(Array.isArray(d.categories) ? d.categories : []);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => reload(), [reload]);

  /** Run one change, say so, and read the list again (the desk's pickers too). */
  async function act(run: () => Promise<unknown>, ok: string, fallback: string): Promise<boolean> {
    try {
      await run();
      toast("ok", ok);
      forgetDeskCategories();
      reload();
      return true;
    } catch (e) {
      toast("error", (e as Error).message || fallback);
      reload();
      return false;
    }
  }

  const nameCheck = (kind: "category" | "sub-category", siblings: { id: number; name: string }[], selfId?: number) => (raw: string) => {
    const name = cleanCategoryName(raw);
    const problem = categoryNameProblem(name, kind);
    if (problem) return problem;
    if (siblings.some((s) => s.id !== selfId && categoryKey(s.name) === categoryKey(name))) {
      return kind === "category" ? `There is already a category called "${name}".` : `It already has a sub-category called "${name}".`;
    }
    return undefined;
  };

  async function addCategory() {
    const v = await promptDialog({
      title: "New category",
      body: "Agents pick it on a ticket. You can add sub-categories to it next.",
      label: "Name",
      placeholder: "Hardware",
      confirmLabel: "Add category",
      validate: nameCheck("category", list ?? []),
    });
    if (v === null) return;
    const name = cleanCategoryName(v);
    await act(() => sendJson(API, "POST", { name }, "Couldn't add the category."), `${name} added.`, "Couldn't add the category.");
  }

  async function addSub(c: HdCategoryAdmin) {
    const v = await promptDialog({
      title: `New sub-category of ${c.name}`,
      label: "Name",
      placeholder: "Laptop",
      confirmLabel: "Add sub-category",
      validate: nameCheck("sub-category", c.subcategories),
    });
    if (v === null) return;
    const name = cleanCategoryName(v);
    await act(() => sendJson(API, "POST", { name, parent_id: c.id }, "Couldn't add the sub-category."), `${name} added to ${c.name}.`, "Couldn't add the sub-category.");
  }

  async function rename(e: Entry) {
    const kind = e.parent ? "sub-category" : "category";
    const v = await promptDialog({
      title: `Rename ${e.name}`,
      body: e.use.tickets
        ? `The ${tickets(e.use.tickets)} that ${e.use.tickets === 1 ? "has" : "have"} it will show the new name. Earlier lines on their timelines keep the old one.`
        : undefined,
      label: "Name",
      initial: e.name,
      confirmLabel: "Rename",
      validate: nameCheck(kind, e.parent ? e.parent.subcategories : (list ?? []), e.id),
    });
    if (v === null) return;
    const name = cleanCategoryName(v);
    if (name === e.name) return;
    await act(() => sendJson(`${API}/${e.id}`, "PATCH", { name }, "Couldn't rename it."), `Renamed to ${name}.`, "Couldn't rename it.");
  }

  async function archive(e: Entry) {
    const ok = await confirmDialog({
      title: `Archive ${e.name}?`,
      body: `Agents can no longer pick it. ${e.use.tickets ? `The ${tickets(e.use.tickets)} that ${e.use.tickets === 1 ? "has" : "have"} it ${e.use.tickets === 1 ? "keeps" : "keep"} it. ` : ""}You can restore it at any time.`,
      confirmLabel: "Archive",
    });
    if (ok !== true) return;
    await act(() => sendJson(`${API}/${e.id}`, "PATCH", { archived: true }, "Couldn't archive it."), `${e.name} archived.`, "Couldn't archive it.");
  }

  async function restore(e: Entry) {
    await act(() => sendJson(`${API}/${e.id}`, "PATCH", { archived: false }, "Couldn't restore it."), `${e.name} restored.`, "Couldn't restore it.");
  }

  async function move(e: Entry, direction: "up" | "down") {
    await act(() => sendJson(`${API}/${e.id}`, "PATCH", { move: direction }, "Couldn't move it."), `${e.name} moved ${direction}.`, "Couldn't move it.");
  }

  async function remove(e: Entry) {
    const kind = e.parent ? "sub-category" : "category";
    if (categoryInUse(e.use)) {
      const go = await confirmDialog({
        title: `${e.name} is still in use`,
        body: `${categoryUseLine(e.use)}. Merge it into another ${kind} to move them, or archive it to keep it on old tickets.`,
        confirmLabel: "Merge into…",
      });
      if (go === true) setMerge(sourceOf(e));
      return;
    }
    const ok = await confirmDialog({
      title: `Delete ${e.name}?`,
      body: `Nothing uses it.${e.children ? ` Its ${e.children} ${e.children === 1 ? "sub-category goes" : "sub-categories go"} with it.` : ""} This cannot be undone.`,
      confirmLabel: `Delete ${kind}`,
      danger: true,
    });
    if (ok !== true) return;
    await act(() => sendJson(`${API}/${e.id}`, "DELETE", undefined, "Couldn't delete it."), `${e.name} deleted.`, "Couldn't delete it.");
  }

  const sourceOf = (e: Entry): MergeSource => ({ id: e.id, name: e.name, use: e.use, parent: e.parent ? { id: e.parent.id, name: e.parent.name } : null, children: e.children });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!list || !q) return list ?? [];
    return list.filter((c) => c.name.toLowerCase().includes(q) || c.subcategories.some((s) => s.name.toLowerCase().includes(q)));
  }, [list, filter]);

  const atLimit = (list?.length ?? 0) >= CATEGORY_LIMITS.categories;
  const addButton = (
    <Button icon={<Plus />} onClick={addCategory} disabled={atLimit} data-testid="hd-category-new">
      New category
    </Button>
  );

  return (
    <PageContainer>
      <PageHeader
        icon={<FolderTree />}
        title="Categories"
        subtitle="The categories and sub-categories agents pick on a ticket."
        actions={atLimit ? <Tooltip label={`The list holds up to ${CATEGORY_LIMITS.categories} categories.`}>{addButton}</Tooltip> : addButton}
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {list === null && !error && <LoadingRow className="py-10" />}
      {list && list.length === 0 && (
        <EmptyState
          icon={<FolderTree />}
          title="No categories yet"
          body="Add the categories agents pick on a ticket, such as Hardware or Access. Each one can have sub-categories. Until you add one, tickets have no category."
          action={{ onClick: addCategory, label: "New category", icon: <Plus /> }}
        />
      )}
      {list && list.length > 0 && (
        // CARD_CLASS, not <Card padding="none">: each row hangs a menu, which overflow-hidden would clip (STYLEGUIDE §Sections and cards).
        <section className={CARD_CLASS} aria-label="Categories" data-testid="hd-categories">
          {list.length > 8 && (
            <div className="border-b border-slate-100 px-4 py-3">
              <ListFilter value={filter} onChange={setFilter} label="Filter categories" placeholder="Filter categories" shown={shown.length} total={list.length} noun="categories" />
            </div>
          )}
          {shown.length === 0 ? (
            <SectionEmpty className="px-4 py-6" action={{ onClick: () => setFilter(""), label: "Clear the filter" }}>
              No category or sub-category matches.
            </SectionEmpty>
          ) : (
            <ul role="list" className="divide-y divide-slate-100">
              {shown.map((c) => {
                const i = list.findIndex((x) => x.id === c.id);
                const entry: Entry = { id: c.id, name: c.name, archived: c.archived, use: c.use, parent: null, children: c.subcategories.length };
                return (
                  <li key={c.id} data-testid="hd-category-row" data-category={c.name}>
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
                        <Folder className="h-4.5 w-4.5" />
                      </span>
                      <RowText name={c.name} archived={c.archived} use={c.use} strong />
                      <div className="flex shrink-0 items-center gap-0.5">
                        <AddSubButton c={c} onAdd={() => void addSub(c)} />
                        <button type="button" onClick={() => void rename(entry)} aria-label={`Rename ${c.name}`} data-tt="Rename" className={iconButtonClass("quiet", "sm")}>
                          <Pencil aria-hidden />
                        </button>
                        <RowMenu
                          name={c.name}
                          archived={c.archived}
                          first={i === 0}
                          last={i === list.length - 1}
                          onMove={(d) => void move(entry, d)}
                          onArchive={() => void (c.archived ? restore(entry) : archive(entry))}
                          onMerge={() => setMerge(sourceOf(entry))}
                          onDelete={() => void remove(entry)}
                          canMerge={list.length > 1}
                        />
                      </div>
                    </div>
                    {c.subcategories.length > 0 && (
                      <ul role="list" aria-label={`Sub-categories of ${c.name}`} className="mb-2 ml-8.5 mr-4 border-l border-slate-200 pl-3">
                        {c.subcategories.map((s, j) => (
                          <SubRow
                            key={s.id}
                            s={s}
                            first={j === 0}
                            last={j === c.subcategories.length - 1}
                            onRename={() => void rename(subEntry(c, s))}
                            onMove={(d) => void move(subEntry(c, s), d)}
                            onArchive={() => void (s.archived ? restore(subEntry(c, s)) : archive(subEntry(c, s)))}
                            onMerge={() => setMerge(sourceOf(subEntry(c, s)))}
                            onDelete={() => void remove(subEntry(c, s))}
                          />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {list && list.length > 0 && (
        <p className="mt-4 text-sm text-slate-500">
          Agents pick from this list on every ticket; nothing is typed. Archive what you no longer use: tickets that have it keep it. To tidy doubles, use Merge into… in a row&rsquo;s menu.
        </p>
      )}
      <CategoryMergeDialog
        source={merge}
        list={list ?? []}
        onClose={() => setMerge(null)}
        onMerged={() => {
          setMerge(null);
          forgetDeskCategories();
          reload();
        }}
      />
    </PageContainer>
  );
}

const subEntry = (c: HdCategoryAdmin, s: HdSubcategoryAdmin): Entry => ({ id: s.id, name: s.name, archived: s.archived, use: s.use, parent: c, children: 0 });

/** The name, its Archived chip and what uses it. */
function RowText({ name, archived, use, strong = false }: { name: string; archived: boolean; use: HdCategoryUse; strong?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`min-w-0 truncate text-sm ${strong ? "font-semibold" : "font-medium"} ${archived ? "text-slate-500" : strong ? "text-slate-900" : "text-slate-800"}`}>{name}</span>
        {archived && (
          <Chip tone="neutral" size="sm">
            <span className="sr-only">, </span>Archived
          </Chip>
        )}
      </span>
      <span className="mt-0.5 block truncate text-xs text-slate-500">{categoryUseLine(use)}</span>
    </span>
  );
}

function AddSubButton({ c, onAdd }: { c: HdCategoryAdmin; onAdd: () => void }) {
  const full = c.subcategories.length >= CATEGORY_LIMITS.subcategories;
  const button = (
    <button type="button" onClick={onAdd} disabled={full} aria-label={`Add a sub-category to ${c.name}`} data-tt={full ? undefined : "Add a sub-category"} className={iconButtonClass("quiet", "sm")}>
      <Plus aria-hidden />
    </button>
  );
  return full ? <Tooltip label={`A category holds up to ${CATEGORY_LIMITS.subcategories} sub-categories.`}>{button}</Tooltip> : button;
}

function SubRow({
  s,
  first,
  last,
  onRename,
  onMove,
  onArchive,
  onMerge,
  onDelete,
}: {
  s: HdSubcategoryAdmin;
  first: boolean;
  last: boolean;
  onRename: () => void;
  onMove: (d: "up" | "down") => void;
  onArchive: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-1" data-testid="hd-subcategory-row" data-subcategory={s.name}>
      <RowText name={s.name} archived={s.archived} use={s.use} />
      <div className="flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={onRename} aria-label={`Rename ${s.name}`} data-tt="Rename" className={iconButtonClass("quiet", "sm")}>
          <Pencil aria-hidden />
        </button>
        <RowMenu name={s.name} archived={s.archived} first={first} last={last} onMove={onMove} onArchive={onArchive} onMerge={onMerge} onDelete={onDelete} canMerge />
      </div>
    </li>
  );
}

/** A row's More menu: moving is a menu, not drag and drop (STYLEGUIDE §Helpdesk: the desk). */
function RowMenu({
  name,
  archived,
  first,
  last,
  canMerge,
  onMove,
  onArchive,
  onMerge,
  onDelete,
}: {
  name: string;
  archived: boolean;
  first: boolean;
  last: boolean;
  canMerge: boolean;
  onMove: (d: "up" | "down") => void;
  onArchive: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${name}`}
        data-tt="More"
        className={iconButtonClass("quiet", "sm")}
      >
        <MoreHorizontal aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label={`Actions for ${name}`} align="end" width="w-48">
        <MenuItem icon={<ArrowUp />} disabled={first} onClick={run(() => onMove("up"))}>
          Move up
        </MenuItem>
        <MenuItem icon={<ArrowDown />} disabled={last} onClick={run(() => onMove("down"))}>
          Move down
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={archived ? <ArchiveRestore /> : <Archive />} onClick={run(onArchive)}>
          {archived ? "Restore" : "Archive"}
        </MenuItem>
        {canMerge && (
          <MenuItem icon={<GitMerge />} onClick={run(onMerge)}>
            Merge into…
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onClick={run(onDelete)}>
          Delete
        </MenuItem>
      </Popover>
    </div>
  );
}

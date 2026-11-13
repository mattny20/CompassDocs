"use client";

// "Category is any of" (1.20.6): the desk admin's list as a checkbox tree,
// for an automation's condition. Ticking a category means every ticket of
// it, whatever its sub-category; ticking a sub-category alone means only
// that one. Archived entries are offered too (marked), since old tickets
// still carry them. Nothing is typed. STYLEGUIDE §Helpdesk: categories.

import Link from "next/link";
import { SectionEmpty } from "@/components/form";
import { categoryKey } from "@/lib/helpdesk/categories-shared";
import { CATEGORIES_SETTINGS_HREF, useDeskCategories } from "./categories";

export interface CategoryPairs {
  categories: string[];
  subcategories: { category: string; subcategory: string }[];
}

export function CategoryChecks({ label, value, onChange }: { label: string; value: CategoryPairs; onChange: (next: CategoryPairs) => void }) {
  const { list, canManage } = useDeskCategories();
  const hasCat = (name: string) => value.categories.some((c) => categoryKey(c) === categoryKey(name));
  const hasPair = (c: string, s: string) => value.subcategories.some((p) => categoryKey(p.category) === categoryKey(c) && categoryKey(p.subcategory) === categoryKey(s));

  function toggleCat(name: string) {
    if (hasCat(name)) onChange({ ...value, categories: value.categories.filter((c) => categoryKey(c) !== categoryKey(name)) });
    // The whole category covers its sub-categories: the single ones under it are dropped.
    else onChange({ categories: [...value.categories, name], subcategories: value.subcategories.filter((p) => categoryKey(p.category) !== categoryKey(name)) });
  }
  function toggleSub(c: string, s: string) {
    if (hasPair(c, s)) onChange({ ...value, subcategories: value.subcategories.filter((p) => !(categoryKey(p.category) === categoryKey(c) && categoryKey(p.subcategory) === categoryKey(s))) });
    else onChange({ ...value, subcategories: [...value.subcategories, { category: c, subcategory: s }] });
  }

  return (
    <fieldset data-testid="category-checks">
      <legend className="mb-1 text-xs font-medium text-slate-500">{label}</legend>
      {list === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : list.length === 0 ? (
        <SectionEmpty action={canManage ? { href: CATEGORIES_SETTINGS_HREF, label: "Add categories" } : undefined}>
          No categories yet.{canManage ? "" : " An admin adds them in Desk settings."}
        </SectionEmpty>
      ) : (
        <>
          <ul role="list" className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-slate-200 px-3 py-2">
            {list.map((c) => {
              const whole = hasCat(c.name);
              return (
                <li key={c.id}>
                  <label className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-800">
                    <input type="checkbox" checked={whole} onChange={() => toggleCat(c.name)} />
                    {c.name}
                    {c.archived && <span className="font-normal text-slate-500">(archived)</span>}
                  </label>
                  {c.subcategories.length > 0 && (
                    <div className="ml-6 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {c.subcategories.map((s) => (
                        <label key={s.id} className={`inline-flex items-center gap-1.5 text-sm ${whole ? "text-slate-500" : "text-slate-700"}`}>
                          <input
                            type="checkbox"
                            checked={whole || hasPair(c.name, s.name)}
                            disabled={whole}
                            onChange={() => toggleSub(c.name, s.name)}
                            aria-label={`${c.name}, ${s.name}`}
                          />
                          {s.name}
                          {s.archived && <span className="text-slate-500">(archived)</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-xs text-slate-500">
            Tick a category for all of its tickets, or only some of its sub-categories.{" "}
            {canManage && (
              <Link href={CATEGORIES_SETTINGS_HREF} className="link">
                Manage categories
              </Link>
            )}
          </p>
        </>
      )}
    </fieldset>
  );
}

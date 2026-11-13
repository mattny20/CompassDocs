"use client";

// A category and its sub-category as two Selects (1.20.6): the request type
// editor, an automation's "Set the category", the queue's Filter dialog and
// Before you solve. Both are picked from the desk admin's list
// (lib/helpdesk/categories); nothing is typed. The sub-category Select shows
// only while the chosen category has sub-categories. A value that is already
// held but is no longer offered (archived) stays selectable as it is.
// STYLEGUIDE §Helpdesk: categories.

import Link from "next/link";
import { Field, Select } from "@/components/form";
import { findCategory } from "@/lib/helpdesk/categories-shared";
import { CATEGORIES_SETTINGS_HREF, pickable, useDeskCategories } from "./categories";

export interface CategoryValue {
  category: string;
  subcategory: string;
}

export function CategoryFields({
  value,
  onChange,
  labels = { category: "Category", subcategory: "Sub-category" },
  none = "None",
  noneSub = "None",
  help,
  errors,
  testid,
}: {
  value: CategoryValue;
  onChange: (next: CategoryValue) => void;
  labels?: { category: string; subcategory: string };
  /** The first option's words ("None", "Leave as it is", "Any category"). */
  none?: string;
  noneSub?: string;
  /** Under the category Select. */
  help?: React.ReactNode;
  errors?: { category?: string; subcategory?: string };
  /** data-testid stem: `<stem>-category`, `<stem>-subcategory`. */
  testid?: string;
}) {
  const { list, canManage } = useDeskCategories();
  const offered = pickable(list);
  const chosen = findCategory(list ?? [], value.category);
  const subs = chosen ? chosen.subcategories.filter((s) => !s.archived) : [];
  // A value held from before that pickers no longer offer.
  const keptCategory = value.category && !findCategory(offered, value.category) ? value.category : "";
  const keptSub = value.subcategory && !findCategory(subs, value.subcategory) ? value.subcategory : "";
  const empty = list !== null && offered.length === 0 && !keptCategory;

  return (
    <>
      <Field
        label={labels.category}
        error={errors?.category}
        help={
          empty ? (
            <>
              No categories yet.{" "}
              {canManage ? (
                <Link href={CATEGORIES_SETTINGS_HREF} className="link font-medium">
                  Add categories
                </Link>
              ) : (
                "An admin adds them in Desk settings."
              )}
            </>
          ) : (
            help
          )
        }
      >
        <Select
          value={findCategory(offered, value.category)?.name ?? keptCategory}
          disabled={empty}
          onChange={(e) => onChange({ category: e.target.value, subcategory: "" })}
          data-testid={testid ? `${testid}-category` : undefined}
        >
          <option value="">{none}</option>
          {offered.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}
            </option>
          ))}
          {keptCategory && (
            <option value={keptCategory}>
              {keptCategory}
              {list === null ? "" : chosen?.archived ? " (archived)" : " (not on the list)"}
            </option>
          )}
        </Select>
      </Field>
      {(subs.length > 0 || keptSub) && (
        <Field label={labels.subcategory} error={errors?.subcategory}>
          <Select
            value={findCategory(subs, value.subcategory)?.name ?? keptSub}
            onChange={(e) => onChange({ category: value.category, subcategory: e.target.value })}
            data-testid={testid ? `${testid}-subcategory` : undefined}
          >
            <option value="">{noneSub}</option>
            {subs.map((s) => (
              <option key={s.id} value={s.name}>
                {s.name}
              </option>
            ))}
            {keptSub && (
              <option value={keptSub}>
                {keptSub}
                {list === null ? "" : " (archived)"}
              </option>
            )}
          </Select>
        </Field>
      )}
    </>
  );
}

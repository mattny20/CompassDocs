"use client";

// How the Directory page looks before a person changes it for themselves: the
// columns the list shows, the field the Groups view opens on, and how names
// sort. One card, one Save. Lived on the Export page until 1.11.2, where it
// shared a screen with the preset editor and was the first thing to scroll
// past.

import { useMemo, useState } from "react";
import { Card } from "@/components/Card";
import { SaveRow } from "@/components/SaveRow";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { DirectoryField } from "@/lib/directory";
import { availableColumns, type NameSortMode } from "@/lib/directory-display";
import { Field, Select } from "@/components/form";
import { toast } from "@/components/Toasts";
import { OrderedKeyList, jsonFetch } from "./shared";

export function DirectoryDisplayPanel({
  fields,
  initialListColumns,
  initialGroupBy,
  initialNameSort = "full",
}: {
  fields: DirectoryField[];
  initialListColumns: string[];
  initialGroupBy: string;
  /** What the list's Name column sorts by until a person picks for themselves. */
  initialNameSort?: NameSortMode;
}) {
  const available = useMemo(() => availableColumns(fields), [fields]);
  const groupFields = useMemo(() => fields.filter((f) => f.group_by), [fields]);

  const [columns, setColumns] = useState(initialListColumns);
  const [groupBy, setGroupBy] = useState(initialGroupBy);
  const [nameSort, setNameSort] = useState<NameSortMode>(initialNameSort);
  const [saving, setSaving] = useState(false);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(JSON.stringify([columns, groupBy, nameSort]));
  useLeaveGuard(dirty, hasUnsavedChanges);

  async function save() {
    setSaving(true);
    const r = await jsonFetch("/api/admin/directory/list-columns", { method: "PUT", body: JSON.stringify({ columns, group_by: groupBy, name_sort: nameSort }) });
    setSaving(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save.");
      return;
    }
    markClean();
    toast("ok", "Directory defaults saved.");
  }

  return (
    <Card
      id="defaults"
      className="scroll-mt-6"
      title="Directory page defaults"
      description="The columns the list shows before a person changes them for themselves, the field the Groups view opens on, and how names sort."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <OrderedKeyList
          value={columns}
          onChange={(next) => {
            setColumns(next);
            markDirty();
          }}
          available={available}
        />
        <div className="space-y-3">
          <Field label="Groups view opens on">
            <Select
              value={groupBy}
              onChange={(e) => {
                setGroupBy(e.target.value);
                markDirty();
              }}
              className="w-full"
            >
              {groupFields.map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Sort names by" help="How the list orders the Name column until a person picks for themselves.">
            <Select
              value={nameSort}
              onChange={(e) => {
                setNameSort(e.target.value === "first" ? "first" : e.target.value === "last" ? "last" : "full");
                markDirty();
              }}
              className="w-full"
            >
              <option value="full">Full name</option>
              <option value="first">First name</option>
              <option value="last">Last name</option>
            </Select>
          </Field>
        </div>
      </div>
      <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save defaults" className="mt-4" />
    </Card>
  );
}

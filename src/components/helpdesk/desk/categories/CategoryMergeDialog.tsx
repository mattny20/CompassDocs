"use client";

// "Merge into…" on the Categories settings page (1.20.6): move everything
// that has one category (or sub-category) to another and remove it. One
// dialog on the house Modal, in the ticket merge dialog's recipe
// (STYLEGUIDE §Helpdesk: merge and bulk edit): the title says what is being
// merged, one lede sentence gives the numbers, a Select picks where it goes,
// a "What happens" card lists exactly what the server will do, and the
// primary says it ("Merge into Hardware"). A refusal shows in the dialog.

import { useEffect, useId, useState } from "react";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/Button";
import { EYEBROW_TEXT } from "@/components/Heading";
import { Field, FormError, Select } from "@/components/form";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toasts";
import { categoryKey, categoryLabel, categoryUseLine, type HdCategoryAdmin, type HdCategoryUse } from "@/lib/helpdesk/categories-shared";
import { sendJson } from "../api";

export interface MergeSource {
  id: number;
  name: string;
  use: HdCategoryUse;
  /** Set: it is a sub-category of this category. */
  parent: { id: number; name: string } | null;
  /** A category's sub-categories. */
  children: number;
}

interface Target {
  id: number;
  label: string;
  /** For a sub-category target: its category. */
  category?: string;
  /** A category taken alone as the target of a sub-category. */
  alone?: boolean;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function CategoryMergeDialog({ source, list, onClose, onMerged }: { source: MergeSource | null; list: HdCategoryAdmin[]; onClose: () => void; onMerged: () => void }) {
  const titleId = useId();
  const ledeId = useId();
  const [into, setInto] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setInto(0);
    setBusy(false);
    setTried(false);
    setError("");
  }, [source?.id]);

  if (!source) return null;
  const isSub = !!source.parent;
  const from = categoryLabel(source.parent?.name ?? source.name, isSub ? source.name : "");
  const active = list.filter((c) => !c.archived);

  // Where it can go: a category into another category; a sub-category into any other
  // sub-category, or into a category alone.
  const groups: { name: string; targets: Target[] }[] = isSub
    ? active.map((c) => ({
        name: c.name,
        targets: [
          { id: c.id, label: `${c.name} (no sub-category)`, alone: true },
          ...c.subcategories.filter((s) => !s.archived && s.id !== source.id).map((s) => ({ id: s.id, label: categoryLabel(c.name, s.name), category: c.name })),
        ],
      }))
    : [];
  const flat: Target[] = isSub ? groups.flatMap((g) => g.targets) : active.filter((c) => c.id !== source.id).map((c) => ({ id: c.id, label: c.name }));
  const target = flat.find((t) => t.id === into) ?? null;
  const targetCategory = !isSub && target ? list.find((c) => c.id === target.id) : undefined;
  const sharedSubs = targetCategory
    ? (list.find((c) => c.id === source.id)?.subcategories ?? []).filter((s) => targetCategory.subcategories.some((x) => categoryKey(x.name) === categoryKey(s.name))).length
    : 0;
  const u = source.use;
  const carriers = [u.request_types ? count(u.request_types, "request type", "request types") : "", u.automations ? count(u.automations, "automation", "automations") : ""].filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!target || !source || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ merged?: { tickets?: number } }>(`/api/helpdesk/admin/categories/${source.id}/merge`, "POST", { into_id: target.id }, "Couldn't merge it.");
      const moved = r.merged?.tickets ?? 0;
      toast("ok", `${from} merged into ${target.alone ? target.label.replace(" (no sub-category)", "") : target.label}.${moved ? ` ${count(moved, "ticket", "tickets")} moved.` : ""}`);
      onMerged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const targetName = target ? (target.alone ? target.label.replace(" (no sub-category)", "") : target.label) : "";
  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      describedBy={ledeId}
      className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <form onSubmit={submit} noValidate data-testid="hd-category-merge">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <GitMerge className="h-4.5 w-4.5 shrink-0 text-slate-700" aria-hidden />
          Merge {from} into…
        </h2>
        <p id={ledeId} className="mt-1 text-sm text-slate-600">
          {categoryUseLine(u) === "Not used yet" ? `Nothing uses ${from} yet.` : `${categoryUseLine(u)} ${u.tickets + u.request_types + u.automations === 1 ? "has" : "have"} ${from}.`} Pick where they go.{" "}
          {from} is then removed from the list.
        </p>

        {flat.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">There is nothing to merge it into yet. Add another {isSub ? "sub-category" : "category"} first.</p>
        ) : (
          <Field label="Merge into" className="mt-4" error={tried && !target ? `Pick a ${isSub ? "sub-category or a category" : "category"}.` : undefined}>
            <Select value={String(into)} onChange={(e) => setInto(Number(e.target.value))} data-autofocus="" data-testid="hd-category-merge-into">
              <option value="0">Choose…</option>
              {isSub
                ? groups.map((g) => (
                    <optgroup key={g.name} label={g.name}>
                      {g.targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </optgroup>
                  ))
                : flat.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
            </Select>
          </Field>
        )}

        {target && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-canvas px-4 py-3">
            <h3 className={EYEBROW_TEXT}>What happens</h3>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-slate-700">
              <li>
                {u.tickets
                  ? target.alone
                    ? `${count(u.tickets, "ticket takes", "tickets take")} the category ${targetName} and no sub-category.`
                    : `${count(u.tickets, "ticket moves", "tickets move")} from ${from} to ${targetName}.`
                  : `No ticket has ${from}, so no ticket changes.`}
              </li>
              {!isSub && source.children > 0 && (
                <li>
                  Its {count(source.children, "sub-category moves", "sub-categories move")} under {targetName}.
                  {sharedSubs > 0 ? ` ${sharedSubs === 1 ? "One" : sharedSubs} that ${targetName} already has by name ${sharedSubs === 1 ? "becomes" : "become"} one with it.` : ""}
                </li>
              )}
              {carriers.length > 0 && (
                <li>
                  The {carriers.join(" and ")} that {u.request_types + u.automations === 1 ? "names" : "name"} {from} will name {targetName}.
                </li>
              )}
              <li>Saved views and report filters that name {from} follow.</li>
              <li>
                <b className="font-semibold">{from}</b> is removed from the list. Earlier lines on ticket timelines keep the old name. This cannot be undone.
              </li>
            </ul>
          </div>
        )}

        <FormError className="mt-3">{error}</FormError>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" icon={<GitMerge />} busy={busy} disabled={flat.length === 0}>
            {target ? `Merge into ${targetName}` : "Merge"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

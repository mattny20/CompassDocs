"use client";

// The workflow builder's Task step: "Checklists" (1.19.2, agent W3). The
// templates the task's ticket gets when the task starts (checklist_ids on
// the step, HdTaskStepDefB). Rows name each chosen checklist with a remove
// button; "Add checklist" is a picker of the library's templates. Required
// items on them must be ticked before the task can be marked done.

import { useEffect, useState } from "react";
import { ListChecks, Plus, X } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { SUB_HEADING_TEXT } from "@/components/Heading";
import { SectionEmpty } from "@/components/form";
import { CHECKLIST_LIMITS } from "@/lib/helpdesk/checklists-shared";
import type { HdTaskStepDefB } from "@/lib/helpdesk/types";
import { getJson } from "../api";
import { PickMenu } from "../PickMenu";

type Option = { id: number; name: string; items: number; required: number };

let cache: Promise<Option[]> | null = null;
function library(): Promise<Option[]> {
  if (!cache) {
    cache = getJson<{ templates: Option[] }>("/api/helpdesk/checklists", "Couldn't load the checklists.")
      .then((r) => r.templates)
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

export function TaskChecklistsSetting({ step, onChange }: { step: HdTaskStepDefB; onChange: (ids: number[] | undefined) => void }) {
  const [options, setOptions] = useState<Option[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    library()
      .then((o) => live && setOptions(o))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const ids = step.checklist_ids ?? [];
  const byId = new Map((options ?? []).map((o) => [o.id, o]));
  const free = (options ?? []).filter((o) => !ids.includes(o.id));
  const set = (next: number[]) => onChange(next.length ? next : undefined);
  return (
    <section className="border-t border-slate-100 pt-4" aria-labelledby={`task-checklists-${step.key}`}>
      <h3 id={`task-checklists-${step.key}`} className={`${SUB_HEADING_TEXT} mb-1 flex items-center gap-1.5`}>
        <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        Checklists
      </h3>
      <p className="text-xs text-slate-500">Added to the task&apos;s ticket when it starts. Its required items must be ticked before the task is done.</p>
      {error && <p className="mt-2 text-xs ink-warn">{error}</p>}
      {ids.length > 0 && (
        <ul className="mt-2">
          {ids.map((id) => {
            const o = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-2 border-b border-slate-100 py-1.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{o ? o.name : options ? "A checklist that was deleted" : "…"}</span>
                {o && (
                  <span className="shrink-0 text-xs text-slate-500">
                    {o.items} {o.items === 1 ? "item" : "items"}
                    {o.required ? ` · ${o.required} required` : ""}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => set(ids.filter((x) => x !== id))}
                  aria-label={`Take ${o?.name ?? "this checklist"} off the task`}
                  data-tt="Remove"
                  className={iconButtonClass("quiet", "sm", "hover-danger")}
                >
                  <X aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {options && options.length === 0 && (
        <SectionEmpty className="mt-2" action={{ href: "/desk/settings/checklists", label: "Make one" }}>
          No checklists in the library yet.
        </SectionEmpty>
      )}
      {free.length > 0 && ids.length < CHECKLIST_LIMITS.perTask && (
        <PickMenu
          label="Add checklist"
          value={null}
          options={free.map((o) => ({ value: o.id, label: o.name, hint: `${o.items} ${o.items === 1 ? "item" : "items"}${o.required ? ` · ${o.required} required` : ""}` }))}
          align="start"
          width="w-64"
          onPick={(id) => set([...ids, id])}
          trigger={(p) => (
            <button {...p} type="button" className={buttonClass("secondary", "sm", "mt-2 [&>svg]:h-3.5 [&>svg]:w-3.5")}>
              <Plus aria-hidden />
              Add checklist
            </button>
          )}
        />
      )}
    </section>
  );
}

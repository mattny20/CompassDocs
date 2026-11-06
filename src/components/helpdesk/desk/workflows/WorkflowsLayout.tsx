"use client";

// /desk/workflows: the workflows rail (each with its request type's icon
// and how many requests it ran this month) beside the builder. Under lg
// the rail and the builder stack: the rail alone at /desk/workflows, the
// builder alone (with a link back) once a workflow is open.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Plus, Workflow } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { railRowClass, railIconClass } from "@/components/RailLink";
import { LoadingRow } from "@/components/Spinner";
import { SectionEmpty } from "@/components/form";
import { promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import type { HdRequestType } from "@/lib/helpdesk/types";
import type { HdWorkflowListRow } from "@/lib/helpdesk/workflows";
import { getJson, itemOf, listOf, sendJson } from "../api";
import { useRequestTypes } from "../admin-data";
import { TeamIcon } from "../TeamIcon";

interface Ctx {
  workflows: HdWorkflowListRow[] | null;
  types: HdRequestType[] | null;
  reload: () => void;
  reloadTypes: () => void;
}
const WfCtx = createContext<Ctx>({ workflows: null, types: null, reload: () => {}, reloadTypes: () => {} });
export const useWorkflows = () => useContext(WfCtx);

export function workflowHref(w: { slug: string; id: number }) {
  return `/desk/workflows/${encodeURIComponent(w.slug || String(w.id))}`;
}

export function WorkflowsLayout({ children }: { children: ReactNode }) {
  const [workflows, setWorkflows] = useState<HdWorkflowListRow[] | null>(null);
  const [error, setError] = useState("");
  const { types, reload: reloadTypes } = useRequestTypes();
  const params = useParams<{ slug?: string }>();
  const router = useRouter();
  const open = params?.slug ? decodeURIComponent(params.slug) : null;

  const reload = useCallback(() => {
    getJson("/api/helpdesk/admin/workflows", "Couldn't load the workflows.")
      .then((d) => {
        setWorkflows(listOf<HdWorkflowListRow>(d, "workflows"));
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => reload(), [reload]);

  async function create() {
    const title = await promptDialog({
      title: "New workflow",
      body: "Name it for the request it handles. You add the steps next; nothing runs until you publish.",
      label: "Name",
      placeholder: "Leaver",
      confirmLabel: "Create workflow",
      validate: (v) => (v.trim().length > 200 ? "Keep it under 200 characters." : undefined),
    });
    if (!title) return;
    try {
      const d = await sendJson("/api/helpdesk/admin/workflows", "POST", { title: title.trim() }, "Couldn't create the workflow.");
      const w = itemOf<HdWorkflowListRow>(d, "workflow");
      toast("ok", "Workflow created.");
      reload();
      router.push(workflowHref(w));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const iconFor = (w: HdWorkflowListRow) => {
    const rt = types?.find((t) => t.workflow_id === w.id || w.request_types?.some((x) => x.id === t.id));
    return rt?.icon || "";
  };

  return (
    <WfCtx.Provider value={{ workflows, types, reload, reloadTypes }}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          aria-label="Workflows"
          className={`min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-surface lg:flex lg:w-64 ${open ? "hidden" : "flex"}`}
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <h2 className="text-base font-semibold text-slate-900">Workflows</h2>
            <button type="button" onClick={create} data-tt="New workflow" aria-label="New workflow" className={iconButtonClass("bordered", "sm")}>
              <Plus aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {error && <p className="px-2 py-3 text-sm text-red-600">{error}</p>}
            {!error && workflows === null && <LoadingRow className="py-6" />}
            {workflows && workflows.length === 0 && (
              <SectionEmpty className="px-2 py-3" action={{ onClick: create, label: "New workflow" }}>
                No workflows yet. Use the starter set in Setup, or build one.
              </SectionEmpty>
            )}
            <ul className="flex flex-col gap-0.5">
              {workflows?.map((w) => {
                const on = open === w.slug || open === String(w.id);
                return (
                  <li key={w.id}>
                    <Link href={workflowHref(w)} aria-current={on ? "page" : undefined} className={`${railRowClass(on)} items-start`}>
                      <span className={`mt-0.5 ${railIconClass(on)}`}>
                        {iconFor(w) ? <TeamIcon name={iconFor(w)} /> : <Workflow className="h-4 w-4" aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{w.title}</span>
                        <span className="block text-xs font-normal text-slate-500">
                          {w.runs_recent} this month
                          {!w.published ? " · draft" : w.has_changes ? " · unpublished changes" : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
        <div className={`min-h-0 min-w-0 flex-1 ${open ? "flex" : "hidden lg:flex"}`}>{children}</div>
      </div>
    </WfCtx.Provider>
  );
}

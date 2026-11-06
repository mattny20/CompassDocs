"use client";

// The workflow builder (/desk/workflows/[slug]): a vertical list of steps
// starting from the request form that triggers it, with a "+" between any
// two steps, parallel groups drawn as a dashed box of task cards ("At the
// same time"), and the selected step's settings in the right-hand panel.
// Edits go into a working draft: Save draft keeps it unpublished, Test run
// shows what each step would do (a dry run on the server), Publish changes
// makes it what new requests run. Running requests keep the version they
// started with.
//
// Moving steps is a menu on each card's grip (Move up, Move down, Remove),
// so it works from the keyboard as well as the pointer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CircleCheck,
  GripVertical,
  ListChecks,
  ListPlus,
  Mail,
  MoreHorizontal,
  Plus,
  Split,
  Stamp,
  Trash2,
  Workflow,
  Wrench,
} from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { PageHeader } from "@/components/PageHeader";
import { LoadingRow } from "@/components/Spinner";
import { EmptyState } from "@/components/form";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdFormField, HdWorkflowDefinition, HdWorkflowStep } from "@/lib/helpdesk/types";
import type { HdWorkflowListRow } from "@/lib/helpdesk/workflows";
import { getJson, itemOf, sendJson } from "../api";
import { useTeams } from "../admin-data";
import { usePeople } from "../people";
import { TeamIcon } from "../TeamIcon";
import { useWorkflows, workflowHref } from "./WorkflowsLayout";
import { StepSettings, TriggerSettings } from "./StepSettings";
import { TestRunModal } from "./TestRunModal";
import { StepBadges } from "../workflow-multi/StepBadges";
import {
  ADD_OPTIONS,
  KIND_LABEL,
  addToGroup,
  canMove,
  countSteps,
  findStep,
  insertAt,
  moveStep,
  newStep,
  removeStep,
  stepSummary,
  ungroupTask,
  updateStep,
  type AddKind,
} from "./model";

const TRIGGER = "__trigger";

const KIND_ICON: Record<string, React.ReactNode> = {
  approval: <Stamp className="h-4 w-4" aria-hidden />,
  task: <Wrench className="h-4 w-4" aria-hidden />,
  wait: <CalendarClock className="h-4 w-4" aria-hidden />,
  notify: <Mail className="h-4 w-4" aria-hidden />,
  finish: <CircleCheck className="h-4 w-4" aria-hidden />,
};

const TILE = "grid h-8 w-8 shrink-0 place-items-center rounded-full";
const TILE_ACCENT = `${TILE} bg-compass-50 text-compass-700`;
const TILE_TRIGGER = `${TILE} bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300`;
const TILE_FINISH = `${TILE} bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300`;

export function WorkflowBuilder({ slug }: { slug: string }) {
  const router = useRouter();
  const { workflows, types, reload } = useWorkflows();
  const { teams } = useTeams();
  const people = usePeople();
  const listRow = workflows?.find((w) => w.slug === slug || String(w.id) === slug) ?? null;
  const [wf, setWf] = useState<HdWorkflowListRow | null>(null);
  const [def, setDef] = useState<HdWorkflowDefinition | null>(null);
  const [selected, setSelected] = useState<string>(TRIGGER);
  const [busy, setBusy] = useState<"" | "save" | "publish">("");
  const [testOpen, setTestOpen] = useState(false);
  const [error, setError] = useState("");
  const snapshot = JSON.stringify(def);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snapshot);
  useLeaveGuard(dirty, hasUnsavedChanges);

  const load = useCallback(
    (id: number) =>
      getJson(`/api/helpdesk/admin/workflows/${id}`, "Couldn't load the workflow.")
        .then((d) => {
          const w = itemOf<HdWorkflowListRow>(d, "workflow");
          setWf(w);
          setDef(w.draft ?? w.definition);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    []
  );

  useEffect(() => {
    if (listRow && listRow.id !== wf?.id) {
      setSelected(TRIGGER);
      void load(listRow.id);
    }
  }, [listRow, wf?.id, load]);

  const teamOptions = useMemo(() => (teams ?? []).map((t) => ({ id: t.id, name: t.name })), [teams]);
  const trigger = types?.find((t) => t.id === def?.trigger.request_type_id) ?? types?.find((t) => t.workflow_id === wf?.id) ?? null;
  const form: HdFormField[] = trigger?.form ?? [];
  const names = {
    team: (id: number) => teamOptions.find((t) => t.id === id)?.name ?? "a team",
    user: (id: number) => {
      const p = people?.find((x) => x.id === id);
      return p ? p.name || p.username : "a named person";
    },
  };

  if (workflows && !listRow) {
    return (
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <EmptyState icon={<Workflow />} title="There's no such workflow" body="It may have been deleted or renamed." action={{ href: "/desk/workflows", label: "All workflows" }} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-w-0 flex-1 p-6">
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </div>
    );
  }
  if (!wf || !def) return <LoadingRow className="flex-1 py-16" />;

  function change(next: HdWorkflowDefinition) {
    markDirty();
    setDef(next);
  }

  function add(index: number, kind: AddKind) {
    if (!def) return;
    const step = newStep(def, kind, teamOptions[0]?.id ?? null);
    change(insertAt(def, index, step));
    setSelected(step.kind === "parallel" ? step.steps[0].key : step.key);
  }

  async function save(): Promise<boolean> {
    if (!wf || !def) return false;
    setBusy("save");
    try {
      const d = await sendJson(`/api/helpdesk/admin/workflows/${wf.id}`, "PATCH", { draft: def }, "Couldn't save the draft.");
      const w = itemOf<HdWorkflowListRow>(d, "workflow");
      markClean(snapshot);
      if (w?.id) setWf(w);
      reload();
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function publish() {
    if (!wf) return;
    if (dirty && !(await save())) return;
    const ok = await confirmDialog({
      title: `Publish ${wf.title}?`,
      body:
        wf.runs_open > 0
          ? `New requests use these steps from now on. The ${wf.runs_open} already on their way finish on the version they started with.`
          : "New requests use these steps from now on.",
      confirmLabel: "Publish changes",
    });
    if (ok !== true) return;
    setBusy("publish");
    try {
      const d = await sendJson<{ workflow?: HdWorkflowListRow; version?: number }>(`/api/helpdesk/admin/workflows/${wf.id}/publish`, "POST", {}, "Couldn't publish the workflow.");
      toast("ok", `Published${d.version ? ` as version ${d.version}` : ""}.`);
      if (d.workflow) {
        setWf(d.workflow);
        setDef(d.workflow.draft ?? d.workflow.definition);
      }
      markClean();
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function rename() {
    if (!wf) return;
    const v = await promptDialog({ title: "Rename workflow", label: "Name", initial: wf.title, confirmLabel: "Rename" });
    if (!v || v.trim() === wf.title) return;
    try {
      const d = await sendJson(`/api/helpdesk/admin/workflows/${wf.id}`, "PATCH", { title: v.trim() }, "Couldn't rename the workflow.");
      const w = itemOf<HdWorkflowListRow>(d, "workflow");
      toast("ok", "Workflow renamed.");
      reload();
      if (w?.slug && w.slug !== slug) router.replace(workflowHref(w));
      else setWf((prev) => (prev ? { ...prev, title: v.trim() } : prev));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function discard() {
    if (!wf) return;
    const ok = await confirmDialog({
      title: "Discard the unpublished changes?",
      body: "The workflow goes back to its published steps. This cannot be undone.",
      confirmLabel: "Discard changes",
      danger: true,
    });
    if (ok !== true) return;
    try {
      const d = await sendJson(`/api/helpdesk/admin/workflows/${wf.id}`, "PATCH", { draft: null }, "Couldn't discard the changes.");
      const w = itemOf<HdWorkflowListRow>(d, "workflow");
      setWf(w);
      setDef(w.draft ?? w.definition);
      markClean(JSON.stringify(w.draft ?? w.definition));
      reload();
      toast("ok", "Changes discarded.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove() {
    if (!wf) return;
    const ok = await confirmDialog({
      title: `Delete ${wf.title}?`,
      body: `${wf.request_types.length ? `${wf.request_types.map((r) => r.title).join(", ")} stop starting it. ` : ""}Requests already on their way finish their steps. This cannot be undone.`,
      confirmLabel: "Delete workflow",
      danger: true,
      typeToConfirm: wf.title,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/workflows/${wf.id}`, "DELETE", undefined, "Couldn't delete the workflow.");
      markClean();
      toast("ok", "Workflow deleted.");
      reload();
      router.push("/desk/workflows");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const n = countSteps(def);
  const state = !wf.published ? "not published yet" : dirty || wf.has_changes ? "unpublished changes" : "published";
  const sel = selected === TRIGGER ? null : findStep(def, selected);

  return (
    // Under xl the steps and the settings panel are one scrolling column;
    // from xl each scrolls on its own beside the other.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
      <section aria-label="Steps" className="min-w-0 px-4 py-5 sm:px-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        <PageHeader
          icon={<Workflow />}
          title={wf.title}
          subtitle={`${trigger ? `Started from Get help by the ${trigger.title} form` : "No request form starts it yet"} · ${n} ${n === 1 ? "step" : "steps"} · ${state}`}
          className="mb-5"
          actions={
            <>
              <Button variant="secondary" onClick={() => setTestOpen(true)}>
                Test run
              </Button>
              {dirty && (
                <Button variant="secondary" busy={busy === "save"} disabled={!!busy} onClick={() => void save().then((ok) => ok && toast("ok", "Draft saved."))}>
                  Save draft
                </Button>
              )}
              <Button busy={busy === "publish"} disabled={!!busy || (!dirty && !wf.has_changes && !!wf.published)} onClick={publish}>
                {wf.published ? "Publish changes" : "Publish"}
              </Button>
              <MoreMenu onRename={rename} onDiscard={wf.has_changes ? discard : undefined} onDelete={remove} />
            </>
          }
        />
        {dirty && <p className="-mt-3 mb-4 text-xs ink-warn">Unsaved changes</p>}

        <ol className="mx-auto max-w-[40rem]" aria-label={`Steps of ${wf.title}`}>
          <li>
            <StepCard
              selected={selected === TRIGGER}
              onSelect={() => setSelected(TRIGGER)}
              tile={<span className={TILE_TRIGGER}><ListChecks className="h-4 w-4" aria-hidden /></span>}
              kind="Starts when"
              title={trigger ? `Someone sends the ${trigger.title} form` : "Choose the request form that starts it"}
              sub={form.length ? `Asks: ${form.map((f) => f.label.toLowerCase()).join(", ")}` : "Select to choose a request form"}
            />
          </li>
          {def.steps.map((s, i) => (
            <li key={s.key}>
              <AddBetween onAdd={(k) => add(i, k)} />
              {s.kind === "parallel" ? (
                <div
                  className={`rounded-xl border border-dashed p-3 transition ${
                    selected === s.key ? "border-compass-500 bg-compass-50/40" : "border-slate-300 bg-slate-50/60"
                  }`}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelected(s.key)}
                      aria-pressed={selected === s.key}
                      className="flex flex-1 items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700"
                    >
                      <Split className="h-3.5 w-3.5" aria-hidden /> At the same time
                    </button>
                    <StepMenu
                      label={`Tasks at the same time (${s.steps.length})`}
                      canUp={canMove(def, s.key, -1)}
                      canDown={canMove(def, s.key, 1)}
                      onUp={() => change(moveStep(def, s.key, -1))}
                      onDown={() => change(moveStep(def, s.key, 1))}
                      onRemove={() => {
                        change(removeStep(def, s.key));
                        setSelected(TRIGGER);
                      }}
                      onAddTask={() => {
                        const r = addToGroup(def, s.key, teamOptions[0]?.id ?? null);
                        change(r.def);
                        setSelected(r.key);
                      }}
                    />
                  </div>
                  <StepBadges step={s} form={form} def={def} teams={teamOptions} className="-mt-1 mb-2 px-1" />
                  <ul className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]">
                    {s.steps.map((t) => (
                      <li key={t.key} className="relative">
                        <StepCard
                          compact
                          selected={selected === t.key}
                          onSelect={() => setSelected(t.key)}
                          tile={<span className={TILE_ACCENT}><TeamIcon name={teams?.find((x) => x.id === t.team_id)?.icon} /></span>}
                          kind={`Task · ${names.team(t.team_id)}`}
                          title={t.title}
                          sub={stepSummary(t, names, form).replace(/^.*?(Due|$)/, "$1") || "No due date"}
                          badges={<StepBadges step={t} form={form} def={def} teams={teamOptions} className="mt-1.5" />}
                          menu={
                            <StepMenu
                              label={t.title}
                              canUp={canMove(def, t.key, -1)}
                              canDown={canMove(def, t.key, 1)}
                              upLabel="Move left"
                              downLabel="Move right"
                              onUp={() => change(moveStep(def, t.key, -1))}
                              onDown={() => change(moveStep(def, t.key, 1))}
                              onRemove={() => {
                                change(removeStep(def, t.key));
                                setSelected(s.key);
                              }}
                            />
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <StepCard
                  selected={selected === s.key}
                  onSelect={() => setSelected(s.key)}
                  tile={<span className={s.kind === "finish" ? TILE_FINISH : TILE_ACCENT}>{KIND_ICON[s.kind]}</span>}
                  kind={s.kind === "task" ? `Task · ${names.team(s.team_id)}` : KIND_LABEL[s.kind]}
                  title={s.title || KIND_LABEL[s.kind]}
                  sub={stepSummary(s, names, form)}
                  badges={<StepBadges step={s} form={form} def={def} teams={teamOptions} className="mt-1.5" />}
                  menu={
                    <StepMenu
                      label={s.title || KIND_LABEL[s.kind]}
                      canUp={canMove(def, s.key, -1)}
                      canDown={canMove(def, s.key, 1)}
                      onUp={() => change(moveStep(def, s.key, -1))}
                      onDown={() => change(moveStep(def, s.key, 1))}
                      onRemove={() => {
                        change(removeStep(def, s.key));
                        setSelected(TRIGGER);
                      }}
                    />
                  }
                />
              )}
            </li>
          ))}
          <li>
            <AddBetween onAdd={(k) => add(def.steps.length, k)} last />
          </li>
        </ol>
      </section>

      <aside aria-label="Step settings" className="shrink-0 border-t border-slate-200 bg-surface px-5 py-5 xl:w-80 xl:overflow-y-auto xl:border-l xl:border-t-0">
        {selected === TRIGGER || !sel ? (
          <TriggerSettings def={def} types={types ?? []} linked={wf.request_types} onChange={change} />
        ) : (
          <StepSettings
            key={sel.step.key}
            step={sel.step}
            inGroup={sel.parent !== null}
            teams={teamOptions}
            people={people ?? []}
            form={form}
            def={def}
            coordinatorTeamId={trigger?.team_id ?? null}
            onChange={(next: HdWorkflowStep) => change(updateStep(def, sel.step.key, next))}
            onUngroup={() => change(ungroupTask(def, sel.step.key))}
            onAddToGroup={() => {
              const r = addToGroup(def, sel.step.key, teamOptions[0]?.id ?? null);
              change(r.def);
              setSelected(r.key);
            }}
          />
        )}
      </aside>

      <TestRunModal open={testOpen} onClose={() => setTestOpen(false)} workflowId={wf.id} definition={def} form={form} />
    </div>
  );
}

function StepCard({
  selected,
  onSelect,
  tile,
  kind,
  title,
  sub,
  menu,
  badges,
  compact = false,
}: {
  badges?: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  tile: React.ReactNode;
  kind: string;
  title: string;
  sub: string;
  menu?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`relative flex gap-3 rounded-xl border bg-surface shadow-xs transition ${compact ? "h-full flex-col p-3" : "items-start p-4"} ${
        selected ? "border-compass-500 ring-2 ring-compass-500/20" : "border-slate-200 hover:border-slate-300"
      }`}
    >
      {tile}
      <div className="min-w-0 flex-1">
        <p className="text-2xs font-semibold uppercase tracking-wider text-slate-500">{kind}</p>
        {/* The whole card selects the step; the button's box is stretched over it. */}
        <button type="button" onClick={onSelect} aria-pressed={selected} className="mt-0.5 block text-left text-sm font-semibold text-slate-900 after:absolute after:inset-0 after:rounded-xl">
          {title}
        </button>
        <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
        {badges}
      </div>
      {menu && <div className={compact ? "absolute right-2 top-2 z-10" : "relative z-10"}>{menu}</div>}
    </div>
  );
}

function StepMenu({
  label,
  canUp,
  canDown,
  onUp,
  onDown,
  onRemove,
  onAddTask,
  upLabel = "Move up",
  downLabel = "Move down",
}: {
  label: string;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onAddTask?: () => void;
  upLabel?: string;
  downLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const act = (fn: () => void) => () => {
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
        aria-label={`Move or remove ${label}`}
        data-tt="Move or remove"
        className={iconButtonClass("quiet", "sm")}
      >
        <GripVertical aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label={`Step: ${label}`} align="end" width="w-48">
        <MenuItem icon={<ArrowUp />} disabled={!canUp} onClick={act(onUp)}>
          {upLabel}
        </MenuItem>
        <MenuItem icon={<ArrowDown />} disabled={!canDown} onClick={act(onDown)}>
          {downLabel}
        </MenuItem>
        {onAddTask && (
          <MenuItem icon={<ListPlus />} onClick={act(onAddTask)}>
            Add a task
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onClick={act(onRemove)}>
          Remove
        </MenuItem>
      </Popover>
    </div>
  );
}

function AddBetween({ onAdd, last = false }: { onAdd: (kind: AddKind) => void; last?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative flex flex-col items-center">
      <span className="h-4 w-0.5 bg-slate-200" aria-hidden />
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={last ? "Add a step at the end" : "Add a step here"}
        data-tt={last ? "Add a step at the end" : "Add a step here"}
        className="grid h-7 w-7 place-items-center rounded-full border border-dashed border-slate-300 bg-surface text-slate-400 transition hover:border-compass-500 hover:text-compass-600"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
      {!last && <span className="h-4 w-0.5 bg-slate-200" aria-hidden />}
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Add a step" width="w-72" className="left-1/2! -translate-x-1/2">
        {ADD_OPTIONS.map((o) => (
          <button
            key={o.kind}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAdd(o.kind);
            }}
            className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50"
          >
            <span className="block text-sm font-medium text-slate-800">{o.label}</span>
            <span className="block text-xs text-slate-500">{o.hint}</span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

function MoreMenu({ onRename, onDiscard, onDelete }: { onRename: () => void; onDiscard?: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const act = (fn: () => void) => () => {
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
        aria-label="More workflow actions"
        data-tt="More"
        className={iconButtonClass("bordered", "md")}
      >
        <MoreHorizontal aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="More workflow actions" align="end" width="w-56">
        <MenuItem onClick={act(onRename)}>Rename…</MenuItem>
        {onDiscard && <MenuItem onClick={act(onDiscard)}>Discard unpublished changes…</MenuItem>}
        <MenuSeparator />
        <MenuItem danger icon={<Trash2 />} onClick={act(onDelete)}>
          Delete workflow…
        </MenuItem>
      </Popover>
    </div>
  );
}

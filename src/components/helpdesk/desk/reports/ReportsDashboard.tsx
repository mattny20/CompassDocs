"use client";

// /desk/reports (1.19.0): the desk's dashboards. Good defaults first: the
// built-in Overview opens with the last 30 days compared with the 30
// before, nothing to set up. Then customisation: switch dashboards, narrow
// every widget with the filter bar (kept in the address, so a link opens
// the same view), export (CSV per widget or the whole dashboard, PDF of
// the dashboard, Print), email it on a schedule, and Edit: add widgets
// from the gallery, configure one in the side panel, reorder by dragging
// or with Move earlier / later, resize, remove, rename, share, save.
// Built-ins are templates: Duplicate makes an editable copy.
//
// Every number is the viewer's own report scope (reports.own, .team or
// .all), enforced by the API; this page never filters on its own.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BarChart3,
  CalendarClock,
  Check,
  ChevronDown,
  Compass,
  Copy,
  Download,
  FileText,
  LayoutDashboard,
  Pencil,
  Plus,
  Printer,
  Settings2,
  Star,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { Button, buttonClass } from "@/components/Button";
import { EmptyState, Field, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { MenuItem, MenuSeparator, Popover } from "@/components/Popover";
import { Modal } from "@/components/Modal";
import { Segmented } from "@/components/Segmented";
import { Skeleton } from "@/components/Skeleton";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { Chip } from "@/components/Chip";
import { DASHBOARD_LIMITS, HD_VISIBILITY_LABEL, type HdDashboard, type HdDashboardLayout, type HdVisibility, type HdWidget } from "@/lib/helpdesk/analytics/shared";
import { defaultState, stateFromParams, stateToParams, type ReportViewState } from "@/lib/helpdesk/analytics/url-state";
import { ApiError } from "../api";
import { FilterBar } from "./FilterBar";
import { WidgetCard } from "./Widget";
import { WidgetGallery, WidgetPanel } from "./WidgetEditor";
import { SchedulesDialog } from "./SchedulesDialog";
import { createDashboard, deleteDashboard, duplicateDashboard, listDashboards, saveDashboard, useReportOptions } from "./data";

function DashboardSwitcher({ dashboards, current, onPick, onNew }: { dashboards: HdDashboard[]; current: HdDashboard; onPick: (d: HdDashboard) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const groups: { label: string; list: HdDashboard[] }[] = [
    { label: "Built in", list: dashboards.filter((d) => d.builtin) },
    { label: "Yours", list: dashboards.filter((d) => !d.builtin && d.visibility === "private") },
    { label: "Shared", list: dashboards.filter((d) => !d.builtin && d.visibility !== "private") },
  ].filter((g) => g.list.length);
  return (
    <div className="relative">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={buttonClass("secondary", "md", "max-w-full gap-2")}>
        <LayoutDashboard className="h-4 w-4 text-compass-600" aria-hidden />
        <span className="truncate">{current.name}</span>
        <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Dashboards" width="w-72" className="max-h-[70vh] overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-slate-500">{g.label}</p>
            {g.list.map((d) => (
              <button
                key={d.id}
                type="button"
                role="menuitemradio"
                aria-checked={d.id === current.id}
                onClick={() => {
                  setOpen(false);
                  onPick(d);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                <span className="w-4 shrink-0" aria-hidden>
                  {d.id === current.id && <Check className="h-4 w-4 text-compass-600" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {d.is_default ? <Star className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-label="Default" /> : null}
              </button>
            ))}
          </div>
        ))}
        <MenuSeparator />
        <MenuItem
          icon={<Plus />}
          onClick={() => {
            setOpen(false);
            onNew();
          }}
        >
          New dashboard
        </MenuItem>
      </Popover>
    </div>
  );
}

function ExportMenu({ dashboard, state, canExport }: { dashboard: HdDashboard; state: ReportViewState; canExport: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const qs = stateToParams(state, defaultState(dashboard.layout)).toString();
  const href = (format: "csv" | "pdf") => `/api/helpdesk/analytics/dashboards/${dashboard.id}/export?format=${format}${qs ? `&${qs}` : ""}`;
  return (
    <div className="relative print:hidden">
      <button ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={buttonClass("secondary", "md")}>
        <Download className="h-4 w-4" aria-hidden /> Export
        <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Export" align="end" width="w-60">
        {canExport ? (
          <>
            <a role="menuitem" href={href("csv")} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setOpen(false)}>
              <Download className="h-4 w-4 text-slate-400" aria-hidden /> Dashboard as CSV
            </a>
            <a role="menuitem" href={href("pdf")} className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setOpen(false)}>
              <FileText className="h-4 w-4 text-slate-400" aria-hidden /> Dashboard as PDF
            </a>
          </>
        ) : (
          <p className="px-2 py-1.5 text-xs text-slate-500">Downloads need the Export tickets capability.</p>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<Printer />}
          onClick={() => {
            setOpen(false);
            window.print();
          }}
        >
          Print…
        </MenuItem>
      </Popover>
    </div>
  );
}

function SettingsDialog({
  open,
  onClose,
  dashboard,
  teams,
  canShareEveryone,
  canSetDefault,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: HdDashboard;
  teams: { id: number; name: string }[];
  canShareEveryone: boolean;
  canSetDefault: boolean;
  onSaved: (d: HdDashboard) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(dashboard.name);
  const [description, setDescription] = useState(dashboard.description);
  const [visibility, setVisibility] = useState<HdVisibility>(dashboard.visibility);
  const [teamId, setTeamId] = useState<number | null>(dashboard.team_id ?? teams[0]?.id ?? null);
  const [isDefault, setIsDefault] = useState(Boolean(dashboard.is_default));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(dashboard.name);
    setDescription(dashboard.description);
    setVisibility(dashboard.visibility);
    setTeamId(dashboard.team_id ?? teams[0]?.id ?? null);
    setIsDefault(Boolean(dashboard.is_default));
  }, [open, dashboard, teams]);
  const vis = (["private", "team", "everyone"] as const).filter((v) => v !== "everyone" || canShareEveryone || dashboard.visibility === "everyone").filter((v) => v !== "team" || teams.length);
  async function save() {
    setBusy(true);
    try {
      const d = await saveDashboard(dashboard.id, {
        ...(dashboard.builtin ? {} : { name: name.trim(), description: description.trim(), visibility, team_id: visibility === "team" ? teamId : null }),
        ...(canSetDefault && isDefault !== Boolean(dashboard.is_default) ? { is_default: isDefault } : {}),
      });
      toast("ok", "Dashboard saved.");
      onSaved(d);
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const ok = await confirmDialog({ title: `Delete ${dashboard.name}?`, body: "The dashboard and its email schedules go for good. Nobody's tickets change.", confirmLabel: "Delete dashboard", danger: true });
    if (!ok) return;
    try {
      await deleteDashboard(dashboard.id);
      toast("ok", "Dashboard deleted.");
      onClose();
      onDeleted();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="hd-dash-settings" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <h2 id="hd-dash-settings" className="mb-4 text-lg font-semibold text-slate-900">
        Dashboard settings
      </h2>
      <div className="space-y-4">
        {!dashboard.builtin && (
          <>
            <Field label="Name">
              <TextInput value={name} maxLength={DASHBOARD_LIMITS.name} onChange={(e) => setName(e.target.value)} data-autofocus />
            </Field>
            <Field label="Description" help="One sentence on what it is for (optional).">
              <Textarea rows={2} value={description} maxLength={DASHBOARD_LIMITS.description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">Who can open it</p>
              <Segmented label="Who can open it" size="sm" value={visibility} onChange={setVisibility} options={vis.map((v) => ({ value: v, label: HD_VISIBILITY_LABEL[v] }))} className="flex-wrap" />
              <p className="mt-1 text-xs text-slate-500">Each person still sees only the tickets they may report on.</p>
            </div>
            {visibility === "team" && (
              <Field label="Team" size="sm">
                <Select value={teamId ?? ""} onChange={(e) => setTeamId(Number(e.target.value))}>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
        {canSetDefault && <Toggle label="Default dashboard" help="What everyone sees first in Reports." checked={isDefault} onChange={setIsDefault} />}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        {dashboard.can_edit ? (
          <Button variant="danger" icon={<Trash2 />} onClick={remove}>
            Delete dashboard
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} busy={busy} disabled={!dashboard.builtin && !name.trim()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function GridSkeleton() {
  return (
    <div role="status" aria-label="Loading the dashboard" className="@container">
      <span className="sr-only">Loading the dashboard</span>
      <div className="grid grid-cols-2 gap-3 @2xl:gap-4 @5xl:grid-cols-4" aria-hidden>
        {[1, 1, 1, 1, 2, 2, 2, 2].map((s, i) => (
          <Skeleton key={i} className={`h-36 rounded-xl ${s === 2 ? "col-span-2 h-64" : ""}`} />
        ))}
      </div>
    </div>
  );
}

export function ReportsDashboard() {
  const router = useRouter();
  const sp = useSearchParams();
  const { options, error: optError } = useReportOptions();
  const [dashboards, setDashboards] = useState<HdDashboard[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<HdDashboardLayout | null>(null);
  const [panel, setPanel] = useState<HdWidget | null>(null);
  const [gallery, setGallery] = useState(false);
  const [schedules, setSchedules] = useState(false);
  const [settings, setSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const dragFrom = useRef<number | null>(null);

  const load = useCallback(() => {
    listDashboards()
      .then((d) => {
        setDashboards(d);
        setError("");
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const wanted = Number(sp?.get("d"));
  const current = useMemo(() => {
    if (!dashboards?.length) return null;
    return dashboards.find((d) => d.id === wanted) ?? dashboards.find((d) => d.is_default) ?? dashboards[0];
  }, [dashboards, wanted]);
  const defaults = useMemo(() => defaultState(current?.layout), [current]);
  const state = useMemo(() => stateFromParams(sp ?? new URLSearchParams(), defaults), [sp, defaults]);
  const editing = draft !== null;
  const layout = draft ?? current?.layout ?? null;

  const go = useCallback(
    (d: HdDashboard | null, s: ReportViewState) => {
      const p = d ? stateToParams(s, defaultState(d.layout), { d: String(d.id) }) : new URLSearchParams();
      router.replace(`/desk/reports${p.toString() ? `?${p}` : ""}`, { scroll: false });
    },
    [router]
  );
  const setState = (s: ReportViewState) => current && go(current, s);

  // Leaving edit mode with changes asks first.
  const dirty = editing && current ? JSON.stringify(draft) !== JSON.stringify(current.layout) : false;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  async function startEdit() {
    if (!current) return;
    if (current.can_edit) {
      setDraft(structuredClone(current.layout));
      return;
    }
    try {
      const copy = await duplicateDashboard(current.id);
      toast("ok", `${copy.name} is yours to change.`);
      setDashboards((list) => [...(list ?? []), copy]);
      // The copy opens on the view being looked at; saving keeps it as the copy's defaults.
      go(copy, state);
      setDraft(structuredClone(copy.layout));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function newDashboard() {
    const name = await promptDialog({ title: "New dashboard", label: "Name", initial: "My dashboard", validate: (v) => (v.trim() ? undefined : "Give it a name.") });
    if (!name) return;
    try {
      const d = await createDashboard({ name: name.trim(), visibility: "private", layout: { widgets: [], filters: {}, range: { preset: "last_30" }, compare: "previous_period" } });
      setDashboards((list) => [...(list ?? []), d]);
      go(d, defaultState(d.layout));
      setDraft(structuredClone(d.layout));
      setGallery(true);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function saveDraft() {
    if (!current || !draft) return;
    setSaving(true);
    try {
      // The filter bar's state becomes the dashboard's defaults.
      const d = await saveDashboard(current.id, { layout: { ...draft, filters: state.filters, range: state.range, compare: state.compare, automated: state.automated } });
      setDashboards((list) => list?.map((x) => (x.id === d.id ? d : x)) ?? null);
      setDraft(null);
      go(d, defaultState(d.layout));
      toast("ok", "Dashboard saved.");
    } catch (e) {
      toast("error", e instanceof ApiError || e instanceof Error ? e.message : "Couldn't save the dashboard.");
    } finally {
      setSaving(false);
    }
  }

  async function cancelEdit() {
    if (dirty && !(await confirmDialog({ title: "Discard your changes?", body: "The dashboard stays as it was saved.", confirmLabel: "Discard changes", danger: true }))) return;
    setDraft(null);
  }

  const widgets = layout?.widgets ?? [];
  const setWidgets = (list: HdWidget[]) => setDraft((d) => (d ? { ...d, widgets: list } : d));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= widgets.length || from === to) return;
    const list = [...widgets];
    const [w] = list.splice(from, 1);
    list.splice(to, 0, w);
    setWidgets(list);
    // Keep focus with the moved card's control.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-widget="${w.id}"] button[aria-label^="Move"]:not([disabled])`)?.focus());
  };

  const subtitle = current?.description || "How the desk is doing. Pick a dashboard, narrow it with the filters, or explore any measure.";

  return (
    <div className="min-w-0 flex-1 overflow-y-auto print:overflow-visible">
      <PageContainer>
        <PageHeader
          icon={<BarChart3 />}
          title="Reports"
          subtitle={subtitle}
          actions={
            current && !editing ? (
              <>
                <Button variant="secondary" href="/desk/reports/explore" icon={<Compass />} className="print:hidden">
                  Explore
                </Button>
                <ExportMenu dashboard={current} state={state} canExport={Boolean(options?.can.export)} />
                <Button variant="secondary" icon={<CalendarClock />} onClick={() => setSchedules(true)} className="print:hidden">
                  Schedule
                </Button>
                <Button icon={current.can_edit ? <Pencil /> : <Copy />} onClick={startEdit} className="print:hidden">
                  {current.can_edit ? "Edit" : "Duplicate to edit"}
                </Button>
              </>
            ) : undefined
          }
        />

        {(error || optError) && (
          <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">
            {error || optError}{" "}
            <button type="button" className="link" onClick={load}>
              Try again
            </button>
          </p>
        )}

        {!dashboards && !error && <GridSkeleton />}

        {current && layout && (
          <>
            {editing ? (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-compass-200 bg-compass-50/70 px-3 py-2 print:hidden">
                <p className="mr-auto text-sm font-semibold text-compass-ink-strong">
                  Editing {current.name}
                  <span className="ml-2 font-normal text-slate-600">The filters you set now are saved as the dashboard's defaults.</span>
                </p>
                <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setGallery(true)} disabled={widgets.length >= DASHBOARD_LIMITS.widgets}>
                  Add widget
                </Button>
                <Button size="sm" variant="secondary" icon={<Settings2 />} onClick={() => setSettings(true)}>
                  Settings
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveDraft} busy={saving}>
                  Save
                </Button>
              </div>
            ) : (
              <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
                <DashboardSwitcher dashboards={dashboards ?? []} current={current} onPick={(d) => go(d, defaultState(d.layout))} onNew={newDashboard} />
                {current.builtin ? (
                  <Chip tone="neutral" size="sm">
                    Built in
                  </Chip>
                ) : current.visibility !== "private" ? (
                  <Chip tone="accent" size="sm">
                    {current.visibility === "team" ? `Shared with ${current.team_name ?? "a team"}` : "Shared with everyone"}
                  </Chip>
                ) : null}
                {options?.can.set_default && !current.can_edit && (
                  <Button size="sm" variant="ghost" icon={<Settings2 />} onClick={() => setSettings(true)}>
                    Settings
                  </Button>
                )}
              </div>
            )}

            <div className="mb-5">
              <FilterBar state={state} onChange={setState} options={options} />
            </div>

            <p className="mb-3 hidden text-sm text-slate-600 print:block">
              {current.name} · {"preset" in state.range ? state.range.preset.replace(/_/g, " ") : `${state.range.from} to ${state.range.to}`}
            </p>

            <h2 className="sr-only">{current.name}</h2>
            {widgets.length === 0 ? (
              <EmptyState
                icon={<LayoutDashboard />}
                title="This dashboard is empty"
                body={editing ? "Add a widget: a number, a chart or a table. Each one shows your own tickets." : "Edit it to add numbers, charts and tables."}
                action={editing ? { label: "Add widget", icon: <Plus />, onClick: () => setGallery(true) } : current.can_edit ? { label: "Edit", icon: <Pencil />, onClick: startEdit } : undefined}
              />
            ) : (
              <div className="@container">
                <div className="grid grid-cols-2 gap-3 @2xl:gap-4 @5xl:grid-cols-4 print:block print:space-y-4">
                  {widgets.map((w, i) => (
                      <WidgetCard
                        key={w.id}
                        dragProps={
                          editing
                            ? {
                                draggable: true,
                                onDragStart: () => (dragFrom.current = i),
                                onDragOver: (e) => e.preventDefault(),
                                onDrop: (e) => {
                                  e.preventDefault();
                                  if (dragFrom.current !== null) move(dragFrom.current, i);
                                  dragFrom.current = null;
                                },
                              }
                            : undefined
                        }
                        widget={w}
                        state={state}
                        canExport={Boolean(options?.can.export)}
                        onClearFilters={() => setState({ ...state, filters: {} })}
                        edit={
                          editing
                            ? {
                                index: i,
                                count: widgets.length,
                                onMove: (to) => move(i, to),
                                onResize: (size) => setWidgets(widgets.map((x) => (x.id === w.id ? { ...x, size } : x))),
                                onConfigure: () => setPanel(w),
                                onRemove: () => setWidgets(widgets.filter((x) => x.id !== w.id)),
                              }
                            : null
                        }
                      />
                  ))}
                </div>
              </div>
            )}
            <p className="mt-6 text-xs text-slate-500 print:hidden">
              Times are business hours in each team&apos;s calendar unless a measure says otherwise; dates are in {options?.timezone ?? "the helpdesk's time zone"}. Click a bar, a point or a row to open its tickets.
            </p>
          </>
        )}

        {current && (
          <>
            <WidgetGallery
              open={gallery}
              onClose={() => setGallery(false)}
              state={state}
              onPick={(w) => {
                setGallery(false);
                setPanel(w);
              }}
            />
            {panel && (
              <WidgetPanel
                key={panel.id}
                initial={panel}
                state={state}
                options={options}
                onClose={() => setPanel(null)}
                onApply={(w) => {
                  setWidgets(widgets.some((x) => x.id === w.id) ? widgets.map((x) => (x.id === w.id ? w : x)) : [...widgets, w]);
                  setPanel(null);
                }}
              />
            )}
            <SchedulesDialog open={schedules} onClose={() => setSchedules(false)} dashboard={current} options={options} canManage={current.can_edit || Boolean(options?.can.manage_shared)} />
            <SettingsDialog
              open={settings}
              onClose={() => setSettings(false)}
              dashboard={current}
              teams={options?.teams ?? []}
              canShareEveryone={Boolean(options?.can.share_everyone)}
              canSetDefault={Boolean(options?.can.set_default)}
              onSaved={(d) => setDashboards((list) => list?.map((x) => (x.id === d.id ? d : x.id !== d.id && d.is_default ? { ...x, is_default: 0 } : x)) ?? null)}
              onDeleted={() => {
                setDraft(null);
                setDashboards((list) => list?.filter((x) => x.id !== current.id) ?? null);
                go(null, defaults);
              }}
            />
          </>
        )}
      </PageContainer>
    </div>
  );
}

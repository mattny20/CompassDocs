"use client";

// Settings → Request types: the cards people pick in Get help and the form
// behind each. A two-pane editor (STYLEGUIDE §Settings pages, "A settings
// list with one editable item at a time"): the list on the left (chips for
// Off and Some groups), the chosen type's editor on the right in grouped
// cards (About, Routing, Who can use it, Questions) with one Save row.
// New request type creates a draft type and opens it.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ListChecks, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Card, CARD_CLASS } from "@/components/Card";
import { chipClass } from "@/components/Chip";
import { EntityPicker } from "@/components/EntityPicker";
import { EmptyState, Field, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { railRowClass } from "@/components/RailLink";
import { SaveRow } from "@/components/SaveRow";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog, promptDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdRequestType } from "@/lib/helpdesk/types";
import { getJson, itemOf, listOf, sendJson } from "../api";
import { useRequestTypes, useTeams } from "../admin-data";
import { TEAM_ICON_NAMES, TeamIcon } from "../TeamIcon";
import { FormBuilder } from "./FormBuilder";
import { CategoryFields } from "../categories/CategoryFields";
import { RequestTypeCalendarCard } from "../calendar/RequestTypeCalendarCard";
import { checkRequestTypeCalendar } from "@/lib/helpdesk/desk-calendar-shared";

export function RequestTypesSettings() {
  const { types, error, reload } = useRequestTypes();
  const { teams } = useTeams();
  const router = useRouter();
  const sp = useSearchParams();
  const [workflows, setWorkflows] = useState<{ id: number; title: string }[]>([]);
  const [groups, setGroups] = useState<{ id: number; name: string }[] | null>(null);
  const chosenId = Number(sp?.get("type")) || types?.[0]?.id || null;
  const chosen = types?.find((t) => t.id === chosenId) ?? null;

  useEffect(() => {
    getJson("/api/helpdesk/admin/workflows").then((d) => setWorkflows(listOf<{ id: number; title: string }>(d, "workflows"))).catch(() => setWorkflows([]));
    getJson("/api/admin/groups").then((d) => setGroups(listOf<{ id: number; name: string }>(d, "groups"))).catch(() => setGroups([]));
  }, []);

  async function create() {
    const title = await promptDialog({
      title: "New request type",
      body: "A card in Get help, like New laptop or Ask HR. You add its questions next; it stays off until you switch it on.",
      label: "Name",
      placeholder: "Parking permit",
      confirmLabel: "Create request type",
    });
    if (!title) return;
    try {
      const d = await sendJson("/api/helpdesk/admin/request-types", "POST", { title: title.trim(), active: 0 }, "Couldn't create the request type.");
      const rt = itemOf<HdRequestType>(d, "request_type");
      toast("ok", "Request type created.");
      reload();
      router.replace(`/desk/settings/request-types?type=${rt.id}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<ListChecks />}
        title="Request types"
        subtitle="The categories people pick in Get help, and the questions each one asks."
        actions={
          <Button icon={<Plus />} onClick={create}>
            New request type
          </Button>
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {types === null && <LoadingRow className="py-10" />}
      {types && types.length === 0 && (
        <EmptyState
          icon={<ListChecks />}
          title="No request types yet"
          body="Without them, Get help offers one plain form. Add types for the requests you see most, or use the starter set."
          action={{ href: "/desk/setup", label: "Open Setup" }}
        />
      )}
      {types && types.length > 0 && (
        <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Request types" className={`${CARD_CLASS} overflow-hidden p-1.5`}>
            {types.map((t) => {
              const on = t.id === chosenId;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-current={on ? "true" : undefined}
                  onClick={() => router.replace(`/desk/settings/request-types?type=${t.id}`)}
                  className={`${railRowClass(on, { dense: true })} w-full text-left`}
                >
                  <span className={on ? "text-compass-600" : "text-slate-400"}>
                    <TeamIcon name={t.icon} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  {!t.active && <span className={chipClass("neutral", "sm")}>Off<span className="sr-only">,</span></span>}
                  {t.visibility === "groups" && <span className={chipClass("info", "sm")}>Some groups</span>}
                </button>
              );
            })}
          </nav>
          <div className="@container min-w-0">
            {chosen && (
              <TypeEditor
                key={chosen.id}
                rt={chosen}
                teams={(teams ?? []).map((t) => ({ id: t.id, name: t.name }))}
                workflows={workflows}
                groups={groups}
                onSaved={reload}
                onDeleted={() => {
                  reload();
                  router.replace("/desk/settings/request-types");
                }}
              />
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function TypeEditor({
  rt,
  teams,
  workflows,
  groups,
  onSaved,
  onDeleted,
}: {
  rt: HdRequestType;
  teams: { id: number; name: string }[];
  workflows: { id: number; title: string }[];
  groups: { id: number; name: string }[] | null;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [v, setV] = useState<HdRequestType>(rt);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const snap = JSON.stringify(v);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);
  const set = (p: Partial<HdRequestType>) => {
    markDirty();
    setV((prev) => ({ ...prev, ...p }));
  };

  const formError = useMemo(() => {
    for (const [i, f] of v.form.entries()) {
      if (!f.label.trim()) return `Question ${i + 1} needs a label.`;
      if ((f.type === "choice" || f.type === "select") && (!f.options?.length || f.options.some((o) => !o.label.trim()))) return `Every option of question ${i + 1} needs a label.`;
    }
    return undefined;
  }, [v.form]);
  const titleError = !v.title.trim() ? "Give the request type a name." : undefined;
  // 1.20.6 "Goes on the calendar": the same check the server makes (lib/helpdesk/desk-calendar-shared).
  const calendarCheck = useMemo(() => checkRequestTypeCalendar(v.calendar ?? null, v.form), [v.calendar, v.form]);
  const calendarError = calendarCheck.ok ? undefined : calendarCheck.error;

  async function save() {
    setTried(true);
    if (formError || titleError || calendarError) return;
    setBusy(true);
    try {
      const d = await sendJson(
        `/api/helpdesk/admin/request-types/${rt.id}`,
        "PATCH",
        {
          title: v.title.trim(),
          description: v.description,
          icon: v.icon,
          team_id: v.team_id,
          category: v.category,
          subcategory: v.subcategory ?? "",
          workflow_id: v.workflow_id,
          sla_priority: v.sla_priority,
          visibility: v.visibility,
          group_ids: v.visibility === "groups" ? v.group_ids ?? [] : [],
          active: v.active,
          eta_label: v.eta_label,
          form: v.form,
          ...(calendarCheck.ok ? { calendar: calendarCheck.value } : {}),
        },
        "Couldn't save the request type."
      );
      const saved = itemOf<HdRequestType>(d, "request_type");
      markClean(JSON.stringify(saved?.id ? { ...v, ...saved } : v));
      if (saved?.id) setV((prev) => ({ ...prev, ...saved }));
      toast("ok", "Request type saved.");
      onSaved();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    let open = 0;
    try {
      const d = await getJson<{ open_requests?: number }>(`/api/helpdesk/admin/request-types/${rt.id}`);
      open = d.open_requests ?? 0;
    } catch {
      /* the dialog says less, that's all */
    }
    const ok = await confirmDialog({
      title: `Delete ${rt.title}?`,
      body: `${open ? `${open} open ${open === 1 ? "request keeps" : "requests keep"} their answers. ` : ""}It disappears from Get help. This cannot be undone.`,
      confirmLabel: "Delete request type",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/request-types/${rt.id}`, "DELETE", undefined, "Couldn't delete the request type.");
      markClean();
      toast("ok", "Request type deleted.");
      onDeleted();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const groupIds = v.group_ids ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <span className="text-compass-600">
            <TeamIcon name={v.icon} />
          </span>
          {v.title || "Untitled"}
        </h2>
        <Button variant="danger" size="sm" icon={<Trash2 />} onClick={remove}>
          Delete
        </Button>
      </div>
      <Card title="About" description="What people see on the card in Get help.">
        <div className="grid gap-4 @2xl:grid-cols-2">
          <Field label="Name" error={tried ? titleError : undefined}>
            <TextInput value={v.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Icon">
            <Select value={v.icon || ""} onChange={(e) => set({ icon: e.target.value })}>
              <option value="">Default</option>
              {TEAM_ICON_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description" className="@2xl:col-span-2">
            <Textarea value={v.description} maxLength={500} className="h-20" onChange={(e) => set({ description: e.target.value })} placeholder="Your manager approves, then IT orders and sets it up." />
          </Field>
          <Field label="How long it takes (optional)" help="Shown on the card: About 3 days, Usually same day.">
            <TextInput value={v.eta_label} maxLength={60} onChange={(e) => set({ eta_label: e.target.value })} />
          </Field>
          <div className="self-end">
            <Toggle label="Show in Get help" help="Off: nobody can pick it; requests already made stay." checked={!!v.active} onChange={(on) => set({ active: on ? 1 : 0 })} size="full" />
          </div>
        </div>
      </Card>
      <Card title="Routing" description="Where its requests go, and what happens next.">
        <div className="grid gap-4 @2xl:grid-cols-2">
          <Field label="Team">
            <Select value={v.team_id ?? ""} onChange={(e) => set({ team_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Decide by the rules</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={v.sla_priority} onChange={(e) => set({ sla_priority: e.target.value as HdRequestType["sla_priority"] })}>
              {HD_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {HD_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Workflow" help="Approvals and tasks that run when someone sends it.">
            <Select value={v.workflow_id ?? ""} onChange={(e) => set({ workflow_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">None: a ticket for the team</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </Select>
          </Field>
          {/* 1.20.6: picked from the desk admin's list (Desk settings → Categories), never typed. */}
          <CategoryFields
            value={{ category: v.category, subcategory: v.subcategory ?? "" }}
            onChange={(next) => set(next)}
            labels={{ category: "Category (optional)", subcategory: "Sub-category (optional)" }}
            help="Set on its tickets, for reports and rules."
            testid="rt"
          />
        </div>
      </Card>
      <Card title="Who can use it">
        <div className="space-y-3">
          <Select value={v.visibility} onChange={(e) => set({ visibility: e.target.value as "all" | "groups" })} aria-label="Who can use it" className="w-auto">
            <option value="all">Everyone</option>
            <option value="groups">Only some groups</option>
          </Select>
          {v.visibility === "groups" &&
            (groups && groups.length > 0 ? (
              <EntityPicker
                options={groups.map((g) => ({ id: g.id, label: g.name }))}
                value={groupIds}
                onChange={(ids) => set({ group_ids: ids })}
                label="Groups that can use it"
                placeholder="Search groups…"
              />
            ) : (
              <p className="text-sm text-slate-500">{groups === null ? "Loading groups…" : "Your account can't list groups; ask an administrator to choose them."}</p>
            ))}
        </div>
      </Card>
      <Card title="Questions" description="Asked after the subject and description. Workflows can use the answers: wait for a start date, approve a cost.">
        <FormBuilder
          form={v.form}
          onChange={(form) => set({ form })}
        />
        {tried && formError && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {formError}
          </p>
        )}
      </Card>
      {/* 1.20.6: requests of this type create a ticket with an event (calendar/RequestTypeCalendarCard). */}
      <RequestTypeCalendarCard
        form={v.form}
        value={v.calendar}
        onChange={(calendar) => set({ calendar })}
        error={tried ? calendarError : undefined}
        onAddQuestion={() => {
          const taken = new Set(v.form.map((f) => f.key));
          let key = "event_start";
          for (let n = 2; taken.has(key); n++) key = `event_start_${n}`;
          set({ form: [...v.form, { key, label: "When does it start?", type: "datetime", required: true }] });
          return key;
        }}
      />
      <SaveRow dirty={dirty} busy={busy} onSave={save} label="Save request type" flush />
    </div>
  );
}

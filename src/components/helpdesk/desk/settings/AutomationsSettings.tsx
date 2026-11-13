"use client";

// Settings → Automations: simple "When … If … Then …" rules, run in order
// (first to last) on ticket events. A list with an on/off switch per rule,
// Move up / Move down, Edit… and Delete…; New rule opens the editor in a
// dialog. Conditions are all optional (none = every ticket); a rule needs
// at least one action.

import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import {
  HD_PRIORITIES,
  HD_PRIORITY_LABEL,
  HD_SOURCES,
  HD_SOURCE_LABEL,
  HD_STATUSES,
  HD_STATUS_LABEL,
  type HdAutomation,
  type HdAutomationActions,
  type HdAutomationConditions,
  type HdAutomationEvent,
  type HdMacro,
  type HdPriority,
  type HdSource,
  type HdStatus,
} from "@/lib/helpdesk/types";
import { getJson, listOf, sendJson } from "../api";
import { useRequestTypes, useTeams } from "../admin-data";
import { categoryLabel } from "@/lib/helpdesk/categories-shared";
import { CategoryChecks, type CategoryPairs } from "../categories/CategoryChecks";
import { CategoryFields } from "../categories/CategoryFields";

const EVENT_FALLBACK: Record<HdAutomationEvent, string> = {
  ticket_created: "A ticket is created",
  ticket_updated: "A ticket is updated",
  requester_message: "The requester sends a message",
  sla_nearing: "An SLA target is close",
  sla_breached: "An SLA target is missed",
};

export function AutomationsSettings() {
  const [rows, setRows] = useState<HdAutomation[] | null>(null);
  const [events, setEvents] = useState<Record<string, string>>(EVENT_FALLBACK);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<HdAutomation | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const { teams } = useTeams();
  const { types } = useRequestTypes();

  const load = () =>
    getJson<{ automations: HdAutomation[]; events?: Record<string, string> }>("/api/helpdesk/admin/automations", "Couldn't load the automations.")
      .then((d) => {
        setRows(listOf<HdAutomation>(d, "automations"));
        if (d.events) setEvents(d.events);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const teamName = (id: number) => teams?.find((t) => t.id === id)?.name ?? "a team";

  async function toggle(a: HdAutomation) {
    try {
      await sendJson(`/api/helpdesk/admin/automations/${a.id}`, "PATCH", { active: a.active ? 0 : 1 }, "Couldn't change the rule.");
      toast("ok", a.active ? `${a.name} is off.` : `${a.name} is on.`);
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function move(i: number, dir: -1 | 1) {
    if (!rows) return;
    const ids = rows.map((r) => r.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setBusy(true);
    try {
      const d = await sendJson<{ automations: HdAutomation[] }>("/api/helpdesk/admin/automations/reorder", "POST", { ids }, "Couldn't change the order.");
      setRows(listOf<HdAutomation>(d, "automations"));
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: HdAutomation) {
    const ok = await confirmDialog({ title: `Delete ${a.name}?`, body: "Tickets it already changed keep those changes. This cannot be undone.", confirmLabel: "Delete rule", danger: true });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/automations/${a.id}`, "DELETE", undefined, "Couldn't delete the rule.");
      toast("ok", "Rule deleted.");
      void load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  function summary(a: HdAutomation): string {
    const c = a.conditions ?? {};
    const parts: string[] = [];
    if (c.team_ids?.length) parts.push(c.team_ids.map(teamName).join(" or "));
    if (c.priorities?.length) parts.push(c.priorities.map((p) => HD_PRIORITY_LABEL[p]).join(" or "));
    if (c.keywords?.length) parts.push(`mentions ${c.keywords.map((k) => `"${k}"`).join(" or ")}`);
    const cats = [...(c.categories ?? []), ...(c.subcategories ?? []).map((p) => categoryLabel(p.category, p.subcategory))];
    if (cats.length) parts.push(`category ${cats.join(" or ")}`);
    if (c.sources?.length) parts.push(`from ${c.sources.map((s) => HD_SOURCE_LABEL[s]).join(" or ")}`);
    if (c.request_type_ids?.length) parts.push(c.request_type_ids.map((id) => types?.find((t) => t.id === id)?.title ?? "a request type").join(" or "));
    const x = a.actions ?? {};
    const then: string[] = [];
    if (x.team_id) then.push(`move to ${teamName(x.team_id)}`);
    if (x.priority) then.push(`set ${HD_PRIORITY_LABEL[x.priority]}`);
    if (x.status) then.push(`set ${HD_STATUS_LABEL[x.status]}`);
    if (x.category) then.push(`category ${categoryLabel(x.category, x.subcategory)}`);
    if (x.tags_add?.length) then.push(`tag ${x.tags_add.join(", ")}`);
    if (x.internal_note) then.push("add a note");
    if (x.macro_id) then.push("send a macro");
    if (x.notify) then.push("notify");
    if (x.assignee_id) then.push("assign");
    return `If ${parts.length ? parts.join(", ") : "any ticket"}, then ${then.join(", ") || "nothing"}.`;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Bot />}
        title="Automations"
        subtitle="Rules that sort and answer tickets for you. They run in this order, first to last."
        actions={
          <Button icon={<Plus />} onClick={() => setEditing("new")}>
            New rule
          </Button>
        }
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {rows === null && !error && <LoadingRow className="py-10" />}
      {rows && rows.length === 0 && (
        <EmptyState icon={<Bot />} title="No rules yet" body="For example: when a ticket mentions VPN, move it to IT and set it High." action={{ onClick: () => setEditing("new"), label: "New rule", icon: <Plus /> }} />
      )}
      {rows && rows.length > 0 && (
        <Card padding="none">
          <ol className="divide-y divide-slate-100">
            {rows.map((a, i) => (
              <li key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap">
                <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                    {a.name}
                    {!a.active && <Chip tone="neutral" size="sm">Off</Chip>}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    When {(events[a.event] ?? a.event).charAt(0).toLowerCase() + (events[a.event] ?? a.event).slice(1)}. {summary(a)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => toggle(a)}>
                    {a.active ? "Turn off" : "Turn on"}
                    <span className="sr-only"> {a.name}</span>
                  </Button>
                  <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${a.name} up`} data-tt="Move up" className={iconButtonClass("quiet", "sm")}>
                    <ArrowUp aria-hidden />
                  </button>
                  <button type="button" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${a.name} down`} data-tt="Move down" className={iconButtonClass("quiet", "sm")}>
                    <ArrowDown aria-hidden />
                  </button>
                  <button type="button" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`} data-tt="Edit" className={iconButtonClass("quiet", "sm")}>
                    <Pencil aria-hidden />
                  </button>
                  <button type="button" onClick={() => remove(a)} aria-label={`Delete ${a.name}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "hover-danger")}>
                    <Trash2 aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
      <RuleDialog
        rule={editing}
        events={events}
        teams={(teams ?? []).map((t) => ({ id: t.id, name: t.name }))}
        types={(types ?? []).map((t) => ({ id: t.id, name: t.title }))}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </PageContainer>
  );
}

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function RuleDialog({
  rule,
  events,
  teams,
  types,
  onClose,
  onSaved,
}: {
  rule: HdAutomation | "new" | null;
  events: Record<string, string>;
  teams: { id: number; name: string }[];
  types: { id: number; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const titleId = useId();
  const existing = rule && rule !== "new" ? rule : null;
  const [name, setName] = useState("");
  const [event, setEvent] = useState<HdAutomationEvent>("ticket_created");
  const [c, setC] = useState<HdAutomationConditions>({});
  const [keywords, setKeywords] = useState("");
  const [categories, setCategories] = useState<CategoryPairs>({ categories: [], subcategories: [] });
  const [x, setX] = useState<HdAutomationActions>({});
  const [tags, setTags] = useState("");
  const [macros, setMacros] = useState<HdMacro[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!rule) return;
    const r = rule === "new" ? null : rule;
    setName(r?.name ?? "");
    setEvent(r?.event ?? "ticket_created");
    setC(r?.conditions ?? {});
    setKeywords((r?.conditions?.keywords ?? []).join(", "));
    setCategories({ categories: r?.conditions?.categories ?? [], subcategories: r?.conditions?.subcategories ?? [] });
    setX(r?.actions ?? {});
    setTags((r?.actions?.tags_add ?? []).join(", "));
    setTried(false);
    setError("");
    getJson("/api/helpdesk/admin/macros").then((d) => setMacros(listOf<HdMacro>(d, "macros"))).catch(() => setMacros([]));
  }, [rule]);

  const actions: HdAutomationActions = { ...x, tags_add: split(tags).length ? split(tags).map((t) => t.toLowerCase()) : undefined };
  for (const k of Object.keys(actions) as (keyof HdAutomationActions)[]) {
    const v = actions[k];
    if (v === undefined || v === "" || v === null) delete actions[k];
  }
  const errs = {
    name: !name.trim() ? "Name the rule." : undefined,
    actions: Object.keys(actions).length === 0 ? "Choose at least one thing for the rule to do." : undefined,
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (errs.name || errs.actions) return;
    const conditions: HdAutomationConditions = {
      ...(c.team_ids?.length ? { team_ids: c.team_ids } : {}),
      ...(c.priorities?.length ? { priorities: c.priorities } : {}),
      ...(c.sources?.length ? { sources: c.sources } : {}),
      ...(c.request_type_ids?.length ? { request_type_ids: c.request_type_ids } : {}),
      ...(split(keywords).length ? { keywords: split(keywords) } : {}),
      ...(categories.categories.length ? { categories: categories.categories } : {}),
      ...(categories.subcategories.length ? { subcategories: categories.subcategories } : {}),
    };
    setBusy(true);
    setError("");
    try {
      const payload = { name: name.trim(), event, conditions, actions };
      if (existing) await sendJson(`/api/helpdesk/admin/automations/${existing.id}`, "PATCH", payload, "Couldn't save the rule.");
      else await sendJson("/api/helpdesk/admin/automations", "POST", { ...payload, active: 1 }, "Couldn't create the rule.");
      toast("ok", existing ? "Rule saved." : "Rule created.");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toggleIn = <T,>(list: T[] | undefined, v: T): T[] => (list?.includes(v) ? list.filter((y) => y !== v) : [...(list ?? []), v]);

  return (
    <Modal open={!!rule} onClose={onClose} labelledBy={titleId} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={save} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {existing ? `Edit ${existing.name}` : "New rule"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <div className="mt-4 space-y-4">
          <Field label="Name" error={tried ? errs.name : undefined}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="VPN and network" />
          </Field>
          <Field label="When">
            <Select value={event} onChange={(e) => setEvent(e.target.value as HdAutomationEvent)}>
              {Object.entries(events).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-800">If (all optional)</legend>
            <div className="space-y-3">
              <CheckRow label="Team" items={teams.map((t) => ({ value: t.id, label: t.name }))} chosen={c.team_ids ?? []} onToggle={(v) => setC({ ...c, team_ids: toggleIn(c.team_ids, v) })} />
              <CheckRow label="Priority" items={HD_PRIORITIES.map((p) => ({ value: p, label: HD_PRIORITY_LABEL[p] }))} chosen={c.priorities ?? []} onToggle={(v) => setC({ ...c, priorities: toggleIn(c.priorities, v as HdPriority) })} />
              <CheckRow label="Came in through" items={HD_SOURCES.map((s) => ({ value: s, label: HD_SOURCE_LABEL[s] }))} chosen={c.sources ?? []} onToggle={(v) => setC({ ...c, sources: toggleIn(c.sources, v as HdSource) })} />
              {types.length > 0 && (
                <CheckRow label="Request type" items={types.map((t) => ({ value: t.id, label: t.name }))} chosen={c.request_type_ids ?? []} onToggle={(v) => setC({ ...c, request_type_ids: toggleIn(c.request_type_ids, v) })} />
              )}
              <Field label="Mentions any of these words" help="In the subject or the first message. Comma-separated.">
                <TextInput value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="vpn, wifi, network" />
              </Field>
              {/* 1.20.6: ticked from the desk admin's list (Desk settings → Categories), never typed. */}
              <CategoryChecks label="Category is any of" value={categories} onChange={setCategories} />
            </div>
          </fieldset>
          <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-800">Then</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Move to team">
                <Select value={x.team_id ?? ""} onChange={(e) => setX({ ...x, team_id: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">Leave as it is</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Set the priority">
                <Select value={x.priority ?? ""} onChange={(e) => setX({ ...x, priority: (e.target.value || undefined) as HdPriority | undefined })}>
                  <option value="">Leave as it is</option>
                  {HD_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {HD_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Set the status">
                <Select value={x.status ?? ""} onChange={(e) => setX({ ...x, status: (e.target.value || undefined) as HdStatus | undefined })}>
                  <option value="">Leave as it is</option>
                  {HD_STATUSES.filter((s) => s !== "new").map((s) => (
                    <option key={s} value={s}>
                      {HD_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* 1.20.6: picked from the desk admin's list; the sub-category goes with its category. */}
              <CategoryFields
                value={{ category: x.category ?? "", subcategory: x.subcategory ?? "" }}
                onChange={(next) => setX({ ...x, category: next.category || undefined, subcategory: next.category && next.subcategory ? next.subcategory : undefined })}
                labels={{ category: "Set the category", subcategory: "Set the sub-category" }}
                none="Leave as it is"
                noneSub="Leave as it is"
                testid="rule"
              />
              <Field label="Add tags" help="Comma-separated.">
                <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
              </Field>
              <Field label="Send a macro reply">
                <Select value={x.macro_id ?? ""} onChange={(e) => setX({ ...x, macro_id: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">None</option>
                  {macros.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Notify">
                <Select
                  value={typeof x.notify === "string" ? x.notify : ""}
                  onChange={(e) => setX({ ...x, notify: (e.target.value || undefined) as "assignee" | "team" | undefined })}
                >
                  <option value="">Nobody</option>
                  <option value="assignee">The owner</option>
                  <option value="team">The team</option>
                </Select>
              </Field>
              <Field label="Add an internal note" className="sm:col-span-2">
                <Textarea value={x.internal_note ?? ""} onChange={(e) => setX({ ...x, internal_note: e.target.value || undefined })} className="h-20" maxLength={5000} />
              </Field>
            </div>
            {tried && errs.actions && (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {errs.actions}
              </p>
            )}
          </fieldset>
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {existing ? "Save rule" : "Create rule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CheckRow<T extends string | number>({ label, items, chosen, onToggle }: { label: string; items: { value: T; label: string }[]; chosen: T[]; onToggle: (v: T) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium text-slate-500">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {items.map((i) => (
          <label key={String(i.value)} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={chosen.includes(i.value)} onChange={() => onToggle(i.value)} />
            {i.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

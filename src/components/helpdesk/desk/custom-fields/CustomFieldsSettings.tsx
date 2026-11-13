"use client";

// Settings → Custom fields (1.20.6, lib/helpdesk/custom-fields): the fields a
// desk admin adds to tickets, by team. A list in the order tickets show them;
// each row says the field's kind, who sees it (Agent only or Public), the
// teams it is assigned to and how many tickets hold a value. A field is
// added and edited in a dialog whose label, kind, help line and options are
// the request form's own builder (settings/FormBuilder, in its single-field
// mode), so a custom field, a request form question and a "Before you solve"
// closing field are one set of kinds. Rows move up and down, are archived
// (kept with their values, no longer shown) and deleted (asks first, and
// says how many tickets hold a value).

import { useCallback, useEffect, useId, useState } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus, TextCursorInput, Trash2, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { EmptyState, FormError, SectionEmpty } from "@/components/form";
import { SectionHeading } from "@/components/Heading";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { RadioCards } from "@/components/PolicyFields";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { Tooltip } from "@/components/Tooltip";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import type { HdFormField, HdFormFieldType } from "@/lib/helpdesk/types";
import {
  CUSTOM_FIELD_KINDS,
  CUSTOM_FIELD_KIND_LABEL,
  CUSTOM_FIELD_LIMITS,
  CUSTOM_FIELD_VISIBILITY_HELP,
  CUSTOM_FIELD_VISIBILITY_LABEL,
  customFieldKeyFrom,
  customFieldTeamsLabel,
  isChoiceKind,
  sameValueShape,
  type HdCustomField,
  type HdCustomFieldVisibility,
} from "@/lib/helpdesk/custom-fields-shared";
import { getJson, sendJson } from "../api";
import { FormBuilder } from "../settings/FormBuilder";

type FieldRow = HdCustomField & { tickets: number };

interface Data {
  fields: FieldRow[];
  teams: { id: number; name: string }[];
  limit: number;
}

const API = "/api/helpdesk/admin/custom-fields";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Pick one · Laptop, Desktop, Phone" */
function kindLine(f: HdCustomField): string {
  const kind = CUSTOM_FIELD_KIND_LABEL[f.type];
  if (!isChoiceKind(f.type) || !f.options.length) return kind;
  const names = f.options.map((o) => o.label);
  return `${kind} · ${names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ")}`;
}

export function CustomFieldsSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<FieldRow | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      getJson<Data>(API, "Couldn't load the custom fields.")
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    []
  );
  useEffect(() => void load(), [load]);

  const active = data?.fields.filter((f) => !f.archived) ?? [];
  const archived = data?.fields.filter((f) => f.archived) ?? [];
  const full = !!data && data.fields.length >= data.limit;

  async function move(f: FieldRow, dir: -1 | 1) {
    const i = active.findIndex((x) => x.id === f.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= active.length || busy) return;
    const ids = active.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setBusy(true);
    try {
      await sendJson(`${API}/order`, "PUT", { ids }, "Couldn't move the field.");
      await load();
      // The row moved under the pointer: keep focus on its own button.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-cf-move="${f.id}:${dir}"]:not(:disabled), [data-cf-move="${f.id}:${-dir}"]:not(:disabled)`)?.focus());
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(f: FieldRow, on: boolean) {
    try {
      await sendJson(`${API}/${f.id}`, "PUT", { archived: on }, on ? "Couldn't archive the field." : "Couldn't restore the field.");
      toast("ok", on ? `${f.label} archived. Its values are kept.` : `${f.label} restored.`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove(f: FieldRow) {
    const ok = await confirmDialog({
      title: `Delete ${f.label}?`,
      body:
        f.tickets > 0
          ? `${f.tickets === 1 ? "1 ticket holds" : `${f.tickets} tickets hold`} a value for this field. Deleting it removes ${f.tickets === 1 ? "that value" : "those values"} for good. To keep ${f.tickets === 1 ? "it" : "them"}, archive the field instead. This cannot be undone.`
          : "No ticket holds a value for this field. This cannot be undone.",
      confirmLabel: "Delete field",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`${API}/${f.id}`, "DELETE", undefined, "Couldn't delete the field.");
      toast("ok", `${f.label} deleted.`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const add = (
    <Button icon={<Plus />} onClick={() => setEditing("new")} disabled={full}>
      New field
    </Button>
  );

  const row = (f: FieldRow, i: number, list: FieldRow[]) => (
    <li key={f.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3" data-testid="hd-custom-field-row">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-sm font-semibold text-slate-900">{f.label}</span>
          <Chip tone={f.visibility === "public" ? "info" : "neutral"} size="sm">
            {CUSTOM_FIELD_VISIBILITY_LABEL[f.visibility]}
          </Chip>
          {f.archived && (
            <Chip tone="neutral" size="sm">
              Archived
            </Chip>
          )}
        </p>
        <p className="mt-0.5 break-words text-xs text-slate-500">
          {kindLine(f)} · {customFieldTeamsLabel(f, data?.teams ?? [])}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Key <span className="font-mono text-slate-600">{f.key}</span> · {f.tickets > 0 ? `Filled in on ${plural(f.tickets, "ticket", "tickets")}` : "Not filled in on any ticket yet"}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {!f.archived && (
          <>
            <button type="button" disabled={i === 0 || busy} onClick={() => move(f, -1)} data-cf-move={`${f.id}:-1`} aria-label={`Move ${f.label} up`} data-tt="Move up" className={iconButtonClass("quiet", "sm")}>
              <ArrowUp aria-hidden />
            </button>
            <button type="button" disabled={i === list.length - 1 || busy} onClick={() => move(f, 1)} data-cf-move={`${f.id}:1`} aria-label={`Move ${f.label} down`} data-tt="Move down" className={iconButtonClass("quiet", "sm")}>
              <ArrowDown aria-hidden />
            </button>
            <button type="button" onClick={() => setEditing(f)} aria-label={`Edit ${f.label}`} data-tt="Edit" className={iconButtonClass("quiet", "sm")}>
              <Pencil aria-hidden />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setArchived(f, !f.archived)}
          aria-label={f.archived ? `Restore ${f.label}` : `Archive ${f.label}`}
          data-tt={f.archived ? "Restore" : "Archive"}
          className={iconButtonClass("quiet", "sm")}
        >
          {f.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        </button>
        <button type="button" onClick={() => remove(f)} aria-label={`Delete ${f.label}`} data-tt="Delete" className={iconButtonClass("quiet", "sm", "hover-danger")}>
          <Trash2 aria-hidden />
        </button>
      </div>
    </li>
  );

  return (
    <PageContainer>
      <PageHeader
        icon={<TextCursorInput />}
        title="Custom fields"
        subtitle="Extra fields on tickets, by team. Agents fill them in on the ticket."
        actions={full ? <Tooltip label={`Up to ${data?.limit ?? CUSTOM_FIELD_LIMITS.fields} custom fields. Delete one you no longer use.`}>{add}</Tooltip> : add}
      />
      {error && <p className="notice-error mb-4 rounded-lg border px-3 py-2 text-sm">{error}</p>}
      {data === null && !error && <LoadingRow className="py-10" />}
      {data && data.fields.length === 0 && (
        <EmptyState
          icon={<TextCursorInput />}
          title="No custom fields yet"
          body="Add a field, such as an order number or a location, and choose the teams whose tickets show it. Until you add one, tickets look as they always have."
          action={{ onClick: () => setEditing("new"), label: "New field", icon: <Plus /> }}
        />
      )}
      {data && data.fields.length > 0 && (
        <>
          <Card padding="none">
            {active.length === 0 ? (
              <SectionEmpty className="px-4 py-6">Every field is archived. Restore one below, or add a new field.</SectionEmpty>
            ) : (
              <ul role="list" className="divide-y divide-slate-100" data-testid="hd-custom-fields">
                {active.map(row)}
              </ul>
            )}
          </Card>
          <p className="mt-4 text-sm text-slate-500">
            A ticket shows the fields of its team, in this order. When a ticket moves to another team it shows that team&apos;s fields. Values already filled in are kept.
          </p>
          {archived.length > 0 && (
            <section className="mt-8" aria-labelledby="cf-archived">
              <SectionHeading id="cf-archived">Archived</SectionHeading>
              <Card padding="none">
                <ul role="list" className="divide-y divide-slate-100" data-testid="hd-custom-fields-archived">
                  {archived.map(row)}
                </ul>
              </Card>
              <p className="mt-3 text-sm text-slate-500">Archived fields are not shown on tickets. Their values are kept and show again if you restore the field.</p>
            </section>
          )}
        </>
      )}
      {editing && data && (
        <FieldDialog
          key={editing === "new" ? "new" : editing.id}
          field={editing === "new" ? null : editing}
          teams={data.teams}
          takenKeys={data.fields.map((f) => f.key)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </PageContainer>
  );
}

const PILL = (on: boolean) =>
  `inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
    on ? "border-compass-300 bg-compass-50 text-compass-800" : "border-slate-200 text-slate-700 hover:border-slate-300"
  }`;

function FieldDialog({
  field,
  teams,
  takenKeys,
  onClose,
  onSaved,
}: {
  field: FieldRow | null;
  teams: { id: number; name: string }[];
  takenKeys: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const titleId = useId();
  // The definition, in the request form's field shape (the builder edits a one-field form).
  const [def, setDef] = useState<HdFormField>(() =>
    field
      ? { key: field.key, label: field.label, type: field.type === "choice" ? "select" : field.type, help: field.help || undefined, options: isChoiceKind(field.type) ? field.options : undefined }
      : { key: "question_1", label: "", type: "text" }
  );
  const [scope, setScope] = useState<"all" | "chosen">(field && !field.all_teams ? "chosen" : "all");
  const [teamIds, setTeamIds] = useState<number[]>(() => (field ? field.team_ids.filter((id) => teams.some((t) => t.id === id)) : []));
  // The field's own teams lead the list (as it was when the dialog opened, so a tick never makes a pill jump).
  const [listed] = useState(() => {
    const own = new Set(field?.team_ids ?? []);
    return [...teams].sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)));
  });
  const [visibility, setVisibility] = useState<HdCustomFieldVisibility>(field?.visibility ?? "agent");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // While tickets hold a value, the kind may only change to one whose values read the same.
  const locked = !!field && field.tickets > 0;
  const kinds = CUSTOM_FIELD_KINDS.filter((k) => !locked || sameValueShape(field!.type, k)).map((k) => ({ value: k, label: CUSTOM_FIELD_KIND_LABEL[k] }));
  const key = field ? field.key : def.label.trim() ? customFieldKeyFrom(def.label, takenKeys) : "";
  const choice = isChoiceKind(def.type);

  const labelError = !def.label.trim() ? "Give the field a label." : def.label.trim().length > CUSTOM_FIELD_LIMITS.label ? `Keep the label under ${CUSTOM_FIELD_LIMITS.label} characters.` : undefined;
  const optionsError = choice && (def.options ?? []).some((o) => !o.label.trim()) ? "Every option needs a name." : undefined;
  const teamsError = scope === "chosen" && !teamIds.length ? "Pick at least one team, or choose All teams." : undefined;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    setError("");
    if (labelError || optionsError || teamsError) return;
    const body = {
      label: def.label.trim(),
      type: def.type as HdFormFieldType,
      help: def.help ?? "",
      options: choice ? (def.options ?? []).map((o) => ({ value: o.value, label: o.label.trim(), ...(o.hint ? { hint: o.hint } : {}) })) : [],
      visibility,
      all_teams: scope === "all",
      team_ids: scope === "all" ? [] : teamIds,
    };
    setBusy(true);
    try {
      if (field) await sendJson(`${API}/${field.id}`, "PUT", body, "Couldn't save the field.");
      else await sendJson(API, "POST", body, "Couldn't create the field.");
      toast("ok", field ? "Field saved." : `${body.label} created.`);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: number) => setTeamIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={save} noValidate data-testid="hd-custom-field-dialog">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold text-slate-900">
            {field ? `Edit ${field.label}` : "New custom field"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-5">
          <div>
            <FormBuilder
              form={[def]}
              onChange={(next) => next[0] && setDef(next[0])}
              single
              kinds={kinds}
              copy={{ noun: "Field", label: "Label", kindLabel: "Kind", placeholder: "Device type", optionPlaceholder: "Laptop" }}
            />
            {tried && (labelError || optionsError) && (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {labelError || optionsError}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500" data-testid="hd-custom-field-key">
              {key ? (
                <>
                  Key <span className="font-mono text-slate-600">{key}</span>. The API, webhooks and the Claude connector use it. It never changes.
                </>
              ) : (
                "The key is made from the label. The API, webhooks and the Claude connector use it."
              )}
              {locked && " Tickets hold values for this field, so its kind stays as it is."}
            </p>
          </div>

          <fieldset>
            <legend className="text-sm font-semibold text-slate-800">Teams</legend>
            <p className="mb-2 mt-0.5 text-xs text-slate-500">Tickets of these teams show the field. A ticket with no team shows only the fields set to All teams.</p>
            <Segmented
              label="Teams"
              size="sm"
              value={scope}
              onChange={setScope}
              className="flex-wrap"
              options={[
                { value: "all", label: "All teams" },
                { value: "chosen", label: "Chosen teams" },
              ]}
            />
            {scope === "chosen" &&
              (teams.length === 0 ? (
                <SectionEmpty className="mt-2">There are no teams yet.</SectionEmpty>
              ) : (
                // A long list of teams scrolls in its own box, so the rest of the dialog stays in reach.
                <div
                  className={`mt-3 flex flex-wrap gap-2 ${listed.length > 12 ? "max-h-44 overflow-y-auto rounded-lg border border-slate-200 p-2" : ""}`}
                  data-testid="hd-custom-field-teams"
                >
                  {listed.map((t) => {
                    const on = teamIds.includes(t.id);
                    return (
                      <label key={t.id} className={PILL(on)}>
                        <input type="checkbox" checked={on} onChange={() => toggle(t.id)} className="h-4 w-4 accent-compass-600" />
                        {t.name}
                      </label>
                    );
                  })}
                </div>
              ))}
            {tried && teamsError && (
              <p role="alert" className="mt-2 text-xs text-red-600">
                {teamsError}
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-slate-800">Who sees it</legend>
            <RadioCards
              label="Who sees it"
              name={`${titleId}-visibility`}
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "agent", label: CUSTOM_FIELD_VISIBILITY_LABEL.agent, description: CUSTOM_FIELD_VISIBILITY_HELP.agent },
                { value: "public", label: CUSTOM_FIELD_VISIBILITY_LABEL.public, description: CUSTOM_FIELD_VISIBILITY_HELP.public },
              ]}
            />
          </fieldset>

          <FormError>{error}</FormError>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {field ? "Save field" : "Create field"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

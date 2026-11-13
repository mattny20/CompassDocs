"use client";

// Settings → Before you solve → one requirement set (1.20.5,
// lib/helpdesk/solve-requirements). The Teams pattern's detail page: the
// set's cards stacked, one Save row with the leave guard, Delete in the
// danger zone.
//
//   Set             its name and the On switch.
//   Applies to      every ticket, or chosen teams and request types (with
//                   both chosen a ticket must match both).
//   On the ticket   the ticket fields that must be set before a solve. Only
//                   the ones this install can meet are offered (a linked
//                   asset needs a connected asset source).
//   Closing fields  what the agent fills in, built with the request form's
//                   builder (settings/FormBuilder) and its field types.
//
// Tickets keep the answers they already have, whatever is changed here.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { DangerAction, DangerZone, EmptyState, Field, SectionEmpty, TextInput, Toggle } from "@/components/form";
import { PageHeader } from "@/components/PageHeader";
import { PageContainer } from "@/components/PageWidth";
import { SaveRow } from "@/components/SaveRow";
import { Segmented } from "@/components/Segmented";
import { LoadingRow } from "@/components/Spinner";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useLeaveGuard, useUnsavedChanges } from "@/lib/use-unsaved";
import type { HdFormField } from "@/lib/helpdesk/types";
import {
  SOLVE_REQ_LIMITS,
  SOLVE_TICKET_FIELD_HELP,
  SOLVE_TICKET_FIELD_LABEL,
  SOLVE_TICKET_FIELDS,
  solveScopeLabel,
  type HdSolveRequirementSet,
  type HdSolveTicketField,
} from "@/lib/helpdesk/solve-requirements-shared";
import { sendJson } from "../api";
import { FormBuilder } from "../settings/FormBuilder";
import { SOLVE_SETTINGS, useSolveSettings, type SolveSettingsData } from "./SolveRequirementsSettings";

const BACK = { href: SOLVE_SETTINGS, label: "Before you solve" };

interface Draft {
  name: string;
  enabled: boolean;
  scope: "all" | "chosen";
  team_ids: number[];
  request_type_ids: number[];
  ticket_fields: HdSolveTicketField[];
  fields: HdFormField[];
}

function draftOf(s: HdSolveRequirementSet, data: SolveSettingsData): Draft {
  // A team or request type deleted since the last save is not carried on.
  const team_ids = s.team_ids.filter((id) => data.teams.some((t) => t.id === id));
  const request_type_ids = s.request_type_ids.filter((id) => data.request_types.some((t) => t.id === id));
  return {
    name: s.name,
    enabled: s.enabled,
    scope: s.team_ids.length || s.request_type_ids.length ? "chosen" : "all",
    team_ids,
    request_type_ids,
    ticket_fields: s.ticket_fields,
    fields: s.fields,
  };
}

export function SolveRequirementSetDetail({ id }: { id: number }) {
  const { data, error, reload } = useSolveSettings();
  const set = data?.sets.find((s) => s.id === id);

  if (error && !data) {
    return (
      <PageContainer>
        <PageHeader back={BACK} icon={<ClipboardCheck />} title="Requirement set" />
        <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>
      </PageContainer>
    );
  }
  if (!data) {
    return (
      <PageContainer>
        <PageHeader back={BACK} icon={<ClipboardCheck />} title="Requirement set" />
        <LoadingRow className="py-10" />
      </PageContainer>
    );
  }
  if (!set) {
    return (
      <PageContainer>
        <PageHeader back={BACK} icon={<ClipboardCheck />} title="Requirement set" />
        <EmptyState
          icon={<ClipboardCheck />}
          title="This requirement set no longer exists"
          body="It may have been deleted. Tickets keep the answers they gave to it."
          action={{ href: SOLVE_SETTINGS, label: "All requirement sets" }}
        />
      </PageContainer>
    );
  }
  return <SetPage key={set.id} set={set} data={data} onChanged={reload} />;
}

const PILL = (on: boolean) =>
  `inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
    on ? "border-compass-300 bg-compass-50 text-compass-800" : "border-slate-200 text-slate-700 hover:border-slate-300"
  }`;

function SetPage({ set, data, onChanged }: { set: HdSolveRequirementSet & { answered: number }; data: SolveSettingsData; onChanged: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(set, data));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const snap = JSON.stringify(draft);
  const { dirty, markDirty, markClean, hasUnsavedChanges } = useUnsavedChanges(snap);
  useLeaveGuard(dirty, hasUnsavedChanges);

  // The saved set changed under a clean form (a reload after a save): follow it.
  const saved = JSON.stringify(draftOf(set, data));
  useEffect(() => {
    if (!hasUnsavedChanges()) setDraft(JSON.parse(saved) as Draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const change = (p: Partial<Draft>) => {
    markDirty();
    setDraft((d) => ({ ...d, ...p }));
  };

  // A field the set already requires stays listed, so it can be seen and taken off, even if this install can't meet it now.
  const offered = SOLVE_TICKET_FIELDS.filter((f) => data.ticket_fields.includes(f) || draft.ticket_fields.includes(f));
  const activeTypes = data.request_types.filter((t) => t.active === 1 || draft.request_type_ids.includes(t.id));

  const nameError = tried && !draft.name.trim() ? "A requirement set needs a name." : undefined;
  const scopeEmpty = draft.scope === "chosen" && !draft.team_ids.length && !draft.request_type_ids.length;
  const scopeError = tried && scopeEmpty ? "Pick at least one team or request type, or choose All tickets." : undefined;
  const nothing = !draft.ticket_fields.length && !draft.fields.length;
  const emptyError = tried && draft.enabled && nothing ? "Add at least one requirement before you switch the set on." : undefined;
  const unlabelled = draft.fields.findIndex((f) => !f.label.trim());
  const optionless = draft.fields.findIndex((f) => (f.type === "choice" || f.type === "select") && (f.options ?? []).some((o) => !o.label.trim()));
  const fieldsError =
    tried && unlabelled >= 0
      ? `Field ${unlabelled + 1} needs a name.`
      : tried && optionless >= 0
        ? `Every option of field ${optionless + 1} needs a name.`
        : undefined;

  async function save() {
    setTried(true);
    if (!draft.name.trim() || scopeEmpty || (draft.enabled && nothing) || unlabelled >= 0 || optionless >= 0) return;
    setSaving(true);
    try {
      await sendJson(
        `/api/helpdesk/admin/solve-requirements/${set.id}`,
        "PUT",
        {
          name: draft.name.trim(),
          enabled: draft.enabled,
          team_ids: draft.scope === "all" ? [] : draft.team_ids,
          request_type_ids: draft.scope === "all" ? [] : draft.request_type_ids,
          ticket_fields: draft.ticket_fields,
          fields: draft.fields,
        },
        "Couldn't save the requirement set."
      );
      markClean(snap);
      toast("ok", "Requirement set saved.");
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete ${set.name}?`,
      body:
        set.answered > 0
          ? `Agents are no longer asked for it. The ${set.answered === 1 ? "ticket" : `${set.answered} tickets`} already answered ${set.answered === 1 ? "keeps its" : "keep their"} answers. This cannot be undone.`
          : "Agents are no longer asked for it. This cannot be undone.",
      confirmLabel: "Delete set",
      danger: true,
    });
    if (ok !== true) return;
    try {
      await sendJson(`/api/helpdesk/admin/solve-requirements/${set.id}`, "DELETE", undefined, "Couldn't delete the requirement set.");
      toast("ok", `${set.name} deleted.`);
      markClean(snap);
      router.push(SOLVE_SETTINGS);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  const toggleId = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <PageContainer>
      <PageHeader
        back={BACK}
        icon={<ClipboardCheck />}
        title={set.name}
        subtitle={`${set.enabled ? "On" : "Off"} · ${solveScopeLabel(set, data.teams, data.request_types)}`}
      />
      <div className="flex flex-col gap-4">
        <Card id="set" className="scroll-mt-6" title="Set">
          <div className="grid gap-4">
            <Field label="Name" error={nameError} size="md">
              <TextInput value={draft.name} onChange={(e) => change({ name: e.target.value })} maxLength={SOLVE_REQ_LIMITS.name} />
            </Field>
            <div>
              <Toggle
                label="On"
                help="While it's on, a ticket it applies to can't be solved until everything below is there."
                checked={draft.enabled}
                onChange={(v) => change({ enabled: v })}
              />
              {emptyError && (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {emptyError}
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card id="applies-to" className="scroll-mt-6" title="Applies to" description="Every set that is on and matches a ticket applies to it.">
          <Segmented
            label="Applies to"
            value={draft.scope}
            onChange={(v) => change({ scope: v })}
            className="flex-wrap"
            options={[
              { value: "all", label: "All tickets" },
              { value: "chosen", label: "Chosen teams and request types" },
            ]}
          />
          {draft.scope === "chosen" && (
            <div className="mt-4 grid gap-4">
              <fieldset>
                <legend className="text-sm font-semibold text-slate-800">Teams</legend>
                <p className="mt-0.5 text-xs text-slate-500">Tickets of these teams. Pick none for every team.</p>
                {data.teams.length === 0 ? (
                  <SectionEmpty className="mt-2">There are no teams yet.</SectionEmpty>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {data.teams.map((t) => {
                      const on = draft.team_ids.includes(t.id);
                      return (
                        <label key={t.id} className={PILL(on)}>
                          <input type="checkbox" checked={on} onChange={() => change({ team_ids: toggleId(draft.team_ids, t.id) })} className="h-4 w-4 accent-compass-600" />
                          {t.name}
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              <fieldset>
                <legend className="text-sm font-semibold text-slate-800">Request types</legend>
                <p className="mt-0.5 text-xs text-slate-500">Requests of these types. Pick none for every ticket of the teams above. With both picked, a ticket must match both.</p>
                {activeTypes.length === 0 ? (
                  <SectionEmpty className="mt-2">There are no request types yet.</SectionEmpty>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {activeTypes.map((t) => {
                      const on = draft.request_type_ids.includes(t.id);
                      return (
                        <label key={t.id} className={PILL(on)}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => change({ request_type_ids: toggleId(draft.request_type_ids, t.id) })}
                            className="h-4 w-4 accent-compass-600"
                          />
                          {t.title}
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              {scopeError && (
                <p role="alert" className="text-xs text-red-600">
                  {scopeError}
                </p>
              )}
            </div>
          )}
        </Card>

        <Card id="ticket-fields" className="scroll-mt-6" title="On the ticket" description="What the ticket must have before it can be solved. The agent can set most of these in the Before you solve dialog.">
          <fieldset>
            <legend className="sr-only">Ticket fields that must be set</legend>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="solve-ticket-fields">
              {offered.map((f) => {
                const on = draft.ticket_fields.includes(f);
                const gone = !data.ticket_fields.includes(f);
                return (
                  <li key={f}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => change({ ticket_fields: on ? draft.ticket_fields.filter((x) => x !== f) : SOLVE_TICKET_FIELDS.filter((x) => x === f || draft.ticket_fields.includes(x)) })}
                        className="mt-0.5 h-4 w-4 accent-compass-600"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800">{SOLVE_TICKET_FIELD_LABEL[f]}</span>
                        <span className="block text-xs text-slate-500">
                          {gone && f === "asset" ? "No asset source is connected, so this isn't asked for now." : SOLVE_TICKET_FIELD_HELP[f]}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </Card>

        <Card
          id="closing-fields"
          className="scroll-mt-6"
          title="Closing fields"
          description="What the agent fills in when they solve. Answers stay on the ticket and show in its side panel as Solve details."
        >
          <FormBuilder
            form={draft.fields}
            onChange={(fields) => change({ fields })}
            max={SOLVE_REQ_LIMITS.fields}
            copy={{
              noun: "Field",
              empty: "No closing fields yet. Add one, such as a resolution code.",
              placeholder: "Resolution code",
              optionPlaceholder: "Fixed",
            }}
          />
          {fieldsError && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {fieldsError}
            </p>
          )}
        </Card>

        <DangerZone>
          <DangerAction label="Delete this requirement set" description="Agents are no longer asked for it. Tickets keep the answers they already have.">
            <Button variant="danger" icon={<Trash2 />} onClick={remove}>
              Delete set…
            </Button>
          </DangerAction>
        </DangerZone>
      </div>
      <SaveRow dirty={dirty} busy={saving} onSave={save} label="Save requirement set" />
    </PageContainer>
  );
}

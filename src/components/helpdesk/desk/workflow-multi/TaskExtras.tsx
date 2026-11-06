"use client";

// A task's multi-team settings in the builder's panel, under its Team and
// Due: "Route to team by answer" (sort the task to a team by a form answer
// or the requester's directory entry, with a fallback), "If the team can't
// do it" (stop and hand back to the coordinating team, or carry on), and
// "Hand-off fields" (what the team fills in when it marks the task done;
// later steps test them in their Only if and quote them in messages as
// {{outputs.<step>.<key>}}).

import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, CircleSlash, ClipboardList, Plus, Signpost, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { SUB_HEADING_TEXT } from "@/components/Heading";
import { Field, Select, TextInput, Textarea, Toggle } from "@/components/form";
import { RadioCards } from "@/components/PolicyFields";
import { OUTPUT_TYPE_LABEL, type HdCantDo, type HdTaskOutputDef, type HdTaskOutputType, type HdTaskRoute, type HdTaskStepDefB } from "./contract";
import {
  fieldId,
  findField,
  keyFromLabel,
  optionsFromLines,
  optionsToLines,
  outputPlaceholder,
  routeSummary,
  type FieldChoice,
} from "./conditions";

type Team = { id: number; name: string };
const MAX_ROUTE_ROWS = 30;
const MAX_OUTPUTS = 20;

// --- Route to team by answer -----------------------------------------------------

export function RouteEditor({
  step,
  fields,
  teams,
  onChange,
}: {
  step: HdTaskStepDefB;
  fields: FieldChoice[];
  teams: Team[];
  onChange: (route: HdTaskRoute | undefined) => void;
}) {
  const headId = useId();
  const route = step.route;
  const teamName = (id: number) => teams.find((t) => t.id === id)?.name ?? "no team";
  const f = route ? findField(fields, route) : undefined;
  const groups = [...new Set(fields.map((x) => x.group))];

  function turnOn(on: boolean) {
    if (!on) return onChange(undefined);
    const first = fields.find((x) => x.kind === "choice") ?? fields[0];
    if (!first) return;
    onChange({ source: first.source as "answer" | "requester", field: first.field, map: rowsFor(first, step, teams), fallback_team_id: null });
  }
  const incomplete = route ? route.map.some((m) => !m.value.trim() || !m.team_id) : false;

  return (
    <section aria-labelledby={headId} className="border-t border-slate-100 pt-4">
      <h3 id={headId} className={`${SUB_HEADING_TEXT} flex items-center gap-1.5`}>
        <Signpost className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        Route to team by answer
      </h3>
      <Toggle
        className="mt-2"
        size="full"
        label="Choose the team from an answer"
        help="For example, Facilities London or Facilities Paris by the requester's office."
        checked={!!route}
        disabled={!fields.length}
        onChange={turnOn}
      />
      {route && (
        <div className="mt-3 space-y-3">
          <Field label="Sort by">
            <Select
              dense
              value={f ? fieldId(f) : ""}
              onChange={(e) => {
                const nf = fields.find((x) => fieldId(x) === e.target.value);
                if (nf && fieldId(nf) !== (f ? fieldId(f) : "")) onChange({ ...route, source: nf.source as "answer" | "requester", field: nf.field, map: rowsFor(nf, step, teams) });
              }}
            >
              {!f && <option value="">Choose a question</option>}
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {fields
                    .filter((x) => x.group === g)
                    .map((x) => (
                      <option key={fieldId(x)} value={fieldId(x)}>
                        {x.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <ol className="space-y-2" aria-label="Answers and their teams">
            {route.map.map((m, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {f?.options?.length ? (
                  <Select
                    dense
                    className="min-w-0 flex-1"
                    aria-label={`Row ${i + 1}: answer`}
                    value={m.value}
                    onChange={(e) => onChange({ ...route, map: route.map.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  >
                    <option value="">Choose…</option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    dense
                    className="min-w-0 flex-1"
                    aria-label={`Row ${i + 1}: answer`}
                    value={m.value}
                    maxLength={200}
                    placeholder="London"
                    onChange={(e) => onChange({ ...route, map: route.map.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  />
                )}
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                <Select
                  dense
                  className="min-w-0 flex-1"
                  aria-label={`Row ${i + 1}: team`}
                  value={m.team_id || ""}
                  onChange={(e) => onChange({ ...route, map: route.map.map((x, j) => (j === i ? { ...x, team_id: Number(e.target.value) } : x)) })}
                >
                  <option value="" disabled>
                    Team
                  </option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  aria-label={`Remove row ${i + 1}`}
                  data-tt="Remove"
                  onClick={() => onChange({ ...route, map: route.map.filter((_, j) => j !== i) })}
                  className={iconButtonClass("quiet", "sm", "hover-danger shrink-0")}
                >
                  <X aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          {incomplete && <p className="text-xs ink-warn">Every row needs an answer and a team; remove the rows you don&apos;t need.</p>}
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus />}
            disabled={route.map.length >= MAX_ROUTE_ROWS}
            onClick={() => onChange({ ...route, map: [...route.map, { value: "", team_id: step.team_id || teams[0]?.id || 0 }] })}
          >
            Add a row
          </Button>
          <Field label="Anything else goes to">
            <Select dense value={route.fallback_team_id ?? ""} onChange={(e) => onChange({ ...route, fallback_team_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">The task's team ({teamName(step.team_id)})</option>
              {teams
                .filter((t) => t.id !== step.team_id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Field>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" aria-live="polite">
            {routeSummary(route, fields, teamName, step.team_id)}.
          </p>
        </div>
      )}
    </section>
  );
}

/** Starting rows for a field: one per option (up to 10), each to the task's team; one blank row for free text. */
function rowsFor(f: FieldChoice, step: HdTaskStepDefB, teams: Team[]): HdTaskRoute["map"] {
  const team = step.team_id || teams[0]?.id || 0;
  return f.options?.length ? f.options.slice(0, 10).map((o) => ({ value: o.value, team_id: team })) : [{ value: "", team_id: team }];
}

// --- If the team can't do it ---------------------------------------------------------

export function CantDoSetting({
  step,
  coordinator,
  onChange,
}: {
  step: HdTaskStepDefB;
  /** The request's own team, which takes the request back. */
  coordinator: string | null;
  onChange: (v: HdCantDo) => void;
}) {
  const who = coordinator || "the request's team";
  return (
    <section className="border-t border-slate-100 pt-4">
      <h3 className={`${SUB_HEADING_TEXT} mb-2 flex items-center gap-1.5`}>
        <CircleSlash className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        If the team can&apos;t do it
      </h3>
      <RadioCards
        label="If the team can't do it"
        name={`cant-${step.key}`}
        value={step.on_cant_do ?? "stop"}
        onChange={onChange}
        options={[
          { value: "stop", label: `Stop and hand back to ${who}`, description: `The workflow waits; ${who} retries the step, skips it or cancels the workflow.` },
          { value: "continue", label: "Carry on", description: "The next steps start anyway; the team's reason shows on the request's progress." },
        ]}
      />
    </section>
  );
}

// --- Hand-off fields -------------------------------------------------------------------

export function OutputsEditor({
  step,
  onChange,
}: {
  step: HdTaskStepDefB;
  onChange: (outputs: HdTaskOutputDef[] | undefined) => void;
}) {
  const headId = useId();
  const outputs = step.outputs ?? [];
  // Keys follow the label only for fields added in this sitting: once saved,
  // a key may be quoted by a later message, so it stays put.
  const fresh = useRef(new Set<string>());
  const set = (next: HdTaskOutputDef[]) => onChange(next.length ? next : undefined);

  function add() {
    const key = keyFromLabel("New field", outputs.map((o) => o.key));
    fresh.current.add(key);
    set([...outputs, { key, label: "", type: "text", required: false }]);
  }

  function edit(i: number, next: HdTaskOutputDef) {
    const prev = outputs[i];
    if (fresh.current.has(prev.key) && next.label !== prev.label) {
      const key = keyFromLabel(next.label || "New field", outputs.filter((_, j) => j !== i).map((o) => o.key));
      fresh.current.delete(prev.key);
      fresh.current.add(key);
      next = { ...next, key };
    }
    set(outputs.map((o, j) => (j === i ? next : o)));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= outputs.length) return;
    const out = outputs.slice();
    [out[i], out[j]] = [out[j], out[i]];
    set(out);
  }

  return (
    <section aria-labelledby={headId} className="border-t border-slate-100 pt-4">
      <h3 id={headId} className={`${SUB_HEADING_TEXT} flex items-center gap-1.5`}>
        <ClipboardList className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        Hand-off fields
      </h3>
      <p className="mt-0.5 text-xs text-slate-500">
        {outputs.length
          ? "The team fills these in when it marks the task done. Later steps can check them and quote them in messages."
          : "Ask the team for what the next teams need: a laptop's asset tag, a badge number, a desk."}
      </p>
      {outputs.length > 0 && (
        <ol className="mt-3 space-y-2" aria-label="Hand-off fields">
          {outputs.map((o, i) => (
            <OutputRow
              key={i}
              n={i + 1}
              out={o}
              stepKey={step.key}
              canUp={i > 0}
              canDown={i < outputs.length - 1}
              onUp={() => move(i, -1)}
              onDown={() => move(i, 1)}
              onRemove={() => set(outputs.filter((_, j) => j !== i))}
              onChange={(next) => edit(i, next)}
            />
          ))}
        </ol>
      )}
      <Button variant="secondary" size="sm" icon={<Plus />} className="mt-3" onClick={add} disabled={outputs.length >= MAX_OUTPUTS}>
        Add a field
      </Button>
    </section>
  );
}

function OutputRow({
  n,
  out,
  stepKey,
  canUp,
  canDown,
  onUp,
  onDown,
  onRemove,
  onChange,
}: {
  n: number;
  out: HdTaskOutputDef;
  stepKey: string;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onChange: (o: HdTaskOutputDef) => void;
}) {
  const [lines, setLines] = useState(() => optionsToLines(out.options));
  const name = out.label || `Field ${n}`;
  return (
    <li className="rounded-lg border border-slate-200 p-2.5">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wider text-slate-500">Field {n}</span>
        <button type="button" onClick={onUp} disabled={!canUp} aria-label={`Move ${name} up`} data-tt="Move up" className={iconButtonClass("quiet", "sm", "disabled:opacity-40")}>
          <ArrowUp aria-hidden />
        </button>
        <button type="button" onClick={onDown} disabled={!canDown} aria-label={`Move ${name} down`} data-tt="Move down" className={iconButtonClass("quiet", "sm", "disabled:opacity-40")}>
          <ArrowDown aria-hidden />
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger")}>
          <X aria-hidden />
        </button>
      </div>
      <div className="mt-1.5 space-y-2">
        <Field label="Label" error={!out.label.trim() ? "Give the field a label." : undefined}>
          <TextInput dense value={out.label} maxLength={80} placeholder="Asset tag" onChange={(e) => onChange({ ...out, label: e.target.value })} />
        </Field>
        <div className="flex items-end gap-3">
          <Field label="Type" className="min-w-0 flex-1">
            <Select
              dense
              value={out.type}
              onChange={(e) => {
                const type = e.target.value as HdTaskOutputType;
                onChange({ ...out, type, options: type === "select" ? out.options ?? [] : undefined });
              }}
            >
              {(Object.keys(OUTPUT_TYPE_LABEL) as HdTaskOutputType[]).map((t) => (
                <option key={t} value={t}>
                  {OUTPUT_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex h-8 items-center gap-1.5 whitespace-nowrap text-sm text-slate-700">
            <input type="checkbox" checked={!!out.required} onChange={(e) => onChange({ ...out, required: e.target.checked })} />
            Required
          </label>
        </div>
        {out.type === "select" && (
          <Field label="Options" help="One per line." error={!out.options?.length ? "Add at least one option." : undefined}>
            <Textarea
              dense
              className="h-20"
              value={lines}
              maxLength={2000}
              onChange={(e) => {
                setLines(e.target.value);
                onChange({ ...out, options: optionsFromLines(e.target.value, out.options) });
              }}
            />
          </Field>
        )}
        <p className="text-xs text-slate-500">
          In messages: <code className="break-all font-mono text-2xs text-slate-700">{outputPlaceholder(stepKey, out.key)}</code>
        </p>
      </div>
    </li>
  );
}

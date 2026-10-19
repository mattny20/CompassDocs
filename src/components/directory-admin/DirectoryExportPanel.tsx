"use client";

// The export presets a PDF/CSV starts from: a list of presets on the left,
// the selected one's editor on the right (PresetList / PresetEditor under
// ./export), one Save for the page. This file is the shell and the state: it
// owns every preset, what has been typed into the inputs that are kept as
// typed (Wrap after, custom margins, recipients), and the rules Save waits
// on across all presets. The list defaults (columns, Groups view, Sort names
// by) are the Display page's (DirectoryDisplayPanel) since 1.11.2.

import { useMemo, useState } from "react";
import { SaveRow } from "@/components/SaveRow";
import { useLeaveGuard } from "@/lib/use-unsaved";
import { confirmDialog } from "@/components/Dialog";
import type { DirectoryField } from "@/lib/directory";
import type { ExportPreset } from "@/lib/directory-export-config";
import { assistantDetailKeys, availableColumns, sortableKeys } from "@/lib/directory-display";
import { FormError, rangeError } from "@/components/form";
import type { ExportSchedule } from "@/lib/directory-export-schedule-rules";
import { toast } from "@/components/Toasts";
import { jsonFetch } from "./shared";
import { PresetList } from "./export/PresetList";
import { PresetEditor, type PresetEditorModel } from "./export/PresetEditor";
import { LIMIT_MAX, LIMIT_MIN, MARGIN_SIDES, PRESET_BLANK, marginError, type MarginSide } from "./export/preset-rules";

export function DirectoryExportPanel({
  fields,
  initialPresets,
  smtpConfigured = false,
  runLog = {},
}: {
  fields: DirectoryField[];
  initialPresets: ExportPreset[];
  /** Whether scheduled emails can be sent at all. */
  smtpConfigured?: boolean;
  /** When each preset last went out on its schedule. */
  runLog?: Record<string, { at: string; ok: boolean; detail?: string }>;
}) {
  const available = useMemo(() => availableColumns(fields), [fields]);
  const groupFields = useMemo(() => fields.filter((f) => f.group_by), [fields]);
  const linkKeys = useMemo(() => new Set(fields.filter((f) => f.kind === "people").map((f) => f.key)), [fields]);
  // Sort keys grouped so a synced custom field is as easy to find as Name.
  // sortableKeys adds First name / Last name after Name: sortable, never a column.
  const sortGroups = useMemo(() => {
    const sortable = sortableKeys(fields);
    const builtin = new Set(["name", "name:first", "name:last", "title", "department", "email", "phone", "mobile", "office"]);
    const isLink = (k: string) => k === "assists" || k.endsWith(":in") || linkKeys.has(k);
    return [
      { label: "Built-in", keys: sortable.filter((c) => builtin.has(c.key)) },
      { label: "Fields", keys: sortable.filter((c) => !builtin.has(c.key) && !isLink(c.key)) },
      { label: "Links", keys: sortable.filter((c) => !builtin.has(c.key) && isLink(c.key)) },
    ].filter((g) => g.keys.length);
  }, [fields, linkKeys]);
  // The assistant's own fields that can follow their name on paper; the same
  // list sanitizePreset keeps, so a tick here is a key the file renders.
  const assistantFieldOptions = useMemo(() => assistantDetailKeys(fields), [fields]);
  const columnLabelOf = (k: string) => available.find((a) => a.key === k)?.label ?? k;

  const [presets, setPresets] = useState<ExportPreset[]>(initialPresets);
  const [selected, setSelected] = useState(0);
  const [savingPresets, setSavingPresets] = useState(false);
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(dirty, () => dirty);
  const cur = presets[selected];

  function update(patch: Partial<ExportPreset>) {
    setPresets((ps) => ps.map((p, i) => (i === selected ? { ...p, ...patch } : p)));
    setDirty(true);
  }
  const [recipientsText, setRecipientsText] = useState<Record<string, string>>({});
  function updateSchedule(patch: Partial<ExportSchedule>) {
    update({ schedule: { ...cur.schedule, ...patch } });
  }

  // "Wrap after": the number is kept as typed so the error can name it;
  // blank is "automatic" and drops the key. Save waits on the committed
  // value at once; the message waits until the input has been left, so a
  // "1" on the way to "12" is not announced as a mistake.
  const limits = cur.column_limits ?? {};
  const [touched, setTouched] = useState<Record<string, Record<string, boolean>>>({});
  function setLimit(key: string, raw: string) {
    const next = { ...limits };
    if (raw === "") delete next[key];
    else next[key] = Number(raw);
    update({ column_limits: next });
  }
  function touchLimit(key: string) {
    setTouched((t) => ({ ...t, [cur.id]: { ...t[cur.id], [key]: true } }));
  }
  const limitProblems = (p: ExportPreset) =>
    Object.entries(p.column_limits ?? {}).flatMap(([key, n]) => {
      const message = rangeError(n, LIMIT_MIN, LIMIT_MAX);
      return message ? [{ key, message }] : [];
    });
  const limitProblem = (p: ExportPreset) => limitProblems(p)[0];
  const shownLimitProblem = limitProblems(cur).find((x) => touched[cur.id]?.[x.key]);
  const limitHelp =
    cur.layout !== "cards"
      ? "Wrap after: characters per line in this column; longer values wrap onto the next line. Blank lets the column size itself."
      : undefined;
  const columnsNote = shownLimitProblem
    ? `Wrap after for ${columnLabelOf(shownLimitProblem.key)}: ${shownLimitProblem.message.charAt(0).toLowerCase()}${shownLimitProblem.message.slice(1)}`
    : limitHelp;

  function toggleAssistantField(key: string, on: boolean) {
    const chosen = new Set(cur.assistant_fields ?? []);
    if (on) chosen.add(key);
    else chosen.delete(key);
    // Kept in the columns' own order, so the paper reads the way the list does.
    update({ assistant_fields: assistantFieldOptions.filter((c) => chosen.has(c.key)).map((c) => c.key) });
  }

  // Custom margins: the text as typed, per preset and side, so a half-typed
  // "0." is not clamped under the admin's fingers. Only a valid number
  // reaches the preset; Save waits while any side is invalid.
  const [marginText, setMarginText] = useState<Record<string, Partial<Record<MarginSide, string>>>>({});
  const marginShown = (p: ExportPreset, side: MarginSide) =>
    marginText[p.id]?.[side] ?? String(p.margin_custom?.[side] ?? PRESET_BLANK.margin_custom[side]);
  function setMargin(side: MarginSide, raw: string) {
    setMarginText((t) => ({ ...t, [cur.id]: { ...t[cur.id], [side]: raw } }));
    if (!marginError(raw)) update({ margin_custom: { ...(cur.margin_custom ?? PRESET_BLANK.margin_custom), [side]: Number(raw) } });
    else setDirty(true);
  }
  const marginProblem = (p: ExportPreset) => p.margins === "custom" && MARGIN_SIDES.some((s) => marginError(marginShown(p, s)));
  // Save waits on every preset; the inline errors show only for the one on
  // screen, so a problem elsewhere is named above the Save row.
  const offending = presets.find((p) => limitProblem(p) || marginProblem(p));
  const invalid = Boolean(offending);
  const curClean = !limitProblem(cur) && !marginProblem(cur);
  /** What was typed into a preset's inputs is dropped with the preset, so a later one with the same id starts clean. */
  function forgetTyped(id: string) {
    setMarginText((t) => {
      const next = { ...t };
      delete next[id];
      return next;
    });
    setTouched((t) => {
      const next = { ...t };
      delete next[id];
      return next;
    });
  }

  function addPreset(from?: ExportPreset) {
    const base = from ? { ...from, is_default: false } : { ...PRESET_BLANK };
    const name = from ? `${from.name} (copy)` : "New export";
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${presets.length + 1}`;
    setPresets((ps) => [...ps, { ...base, id, name }]);
    setSelected(presets.length);
    setDirty(true);
  }
  async function removePreset() {
    if (presets.length <= 1) return;
    if (!(await confirmDialog({ title: `Delete the "${cur.name}" preset?`, confirmLabel: "Delete", danger: true }))) return;
    forgetTyped(cur.id);
    const next = presets.filter((_, i) => i !== selected);
    if (!next.some((p) => p.is_default)) next[0] = { ...next[0], is_default: true };
    setPresets(next);
    setSelected(0);
    setDirty(true);
  }
  function makeDefault() {
    setPresets((ps) => ps.map((p, i) => ({ ...p, is_default: i === selected })));
    setDirty(true);
  }
  async function savePresets() {
    setSavingPresets(true);
    const r = await jsonFetch("/api/admin/directory/export-presets", { method: "PUT", body: JSON.stringify({ presets }) });
    setSavingPresets(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save the presets.");
      return;
    }
    setPresets(r.data.presets);
    // The inputs now show what was saved, not what was typed.
    setMarginText({});
    setTouched({});
    setDirty(false);
    toast("ok", "Export presets saved.");
  }

  const model: PresetEditorModel = {
    cur,
    update,
    updateSchedule,
    available,
    groupFields,
    sortGroups,
    assistantFieldOptions,
    toggleAssistantField,
    limits,
    setLimit,
    touchLimit,
    limitTouched: (key) => Boolean(touched[cur.id]?.[key]),
    columnsNote,
    columnsNoteIsError: Boolean(shownLimitProblem),
    marginShown: (side) => marginShown(cur, side),
    setMargin,
    recipientsText: recipientsText[cur.id],
    setRecipientsText: (text) => setRecipientsText({ ...recipientsText, [cur.id]: text }),
    commitRecipients: (raw) => updateSchedule({ recipients: raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean) }),
    smtpConfigured,
    lastRun: runLog[cur.id],
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        What comes out of <strong>Export</strong> on the Directory page: a PDF (or CSV) with these columns,
        sections, paper and branding. One preset is the default; people can also export exactly what they
        have on screen.
      </p>

      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        <PresetList presets={presets} selected={selected} onSelect={setSelected} onNew={() => addPreset()} />
        <PresetEditor
          model={model}
          dirty={dirty}
          canDelete={presets.length > 1}
          onMakeDefault={makeDefault}
          onDuplicate={() => addPreset(cur)}
          onDelete={removePreset}
        />
      </div>

      {offending && curClean && (
        <FormError>{`Fix the Wrap after or margin values in "${offending.name}" before saving.`}</FormError>
      )}
      <SaveRow dirty={dirty} busy={savingPresets} onSave={savePresets} label="Save presets" disabled={invalid} />
    </div>
  );
}

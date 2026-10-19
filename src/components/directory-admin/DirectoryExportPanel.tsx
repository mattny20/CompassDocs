"use client";

// How the directory looks by default (list columns, opening group-by) and the
// export presets a PDF/CSV starts from. Both are admin choices that every
// user sees before they change anything for themselves.

import { useId, useMemo, useState } from "react";
import { SaveRow } from "@/components/SaveRow";
import { SettingsLink } from "@/components/SettingsLink";
import { useLeaveGuard } from "@/lib/use-unsaved";
import { confirmDialog } from "@/components/Dialog";
import { buttonClass } from "@/components/Button";
import { Download, Copy, Plus, Trash2 } from "lucide-react";
import type { DirectoryField } from "@/lib/directory";
import type { ExportPreset } from "@/lib/directory-export-config";
import { assistantDetailKeys, availableColumns, sortableKeys, type NameSortMode } from "@/lib/directory-display";
import { Field, Select, TextInput, Toggle, rangeError } from "@/components/form";
import { describeSchedule, WEEKDAYS, type ExportSchedule } from "@/lib/directory-export-schedule-rules";
import { toast } from "@/components/Toasts";
import { OrderedKeyList, jsonFetch } from "./shared";

/** "Wrap after": characters per line a limited column holds (the contract's 8..120). */
const LIMIT_MIN = 8;
const LIMIT_MAX = 120;
/** Custom margins, in inches (the contract's 0.2..2.0). */
const MARGIN_MIN = 0.2;
const MARGIN_MAX = 2;
const MARGIN_SIDES = ["top", "right", "bottom", "left"] as const;
type MarginSide = (typeof MARGIN_SIDES)[number];
const MARGIN_LABEL: Record<MarginSide, string> = { top: "Top", right: "Right", bottom: "Bottom", left: "Left" };

/** Inline validation for a margin: a decimal between 0.2 and 2 inches. */
function marginError(value: number | string): string | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (value === "" || Number.isNaN(n)) return "Enter a number.";
  if (n < MARGIN_MIN || n > MARGIN_MAX) return `Must be between ${MARGIN_MIN} and ${MARGIN_MAX}.`;
  return undefined;
}

const PRESET_BLANK: Omit<ExportPreset, "id" | "name"> = {
  title: "",
  subtitle: "",
  paper: "letter",
  orientation: "portrait",
  density: "normal",
  logo: true,
  columns: ["name", "title", "department", "phone", "email"],
  group_by: "",
  sort: "name",
  sort_dir: "asc",
  sort2: "",
  sort2_dir: "asc",
  page_columns: 1,
  zebra: true,
  filter: null,
  photos: false,
  pinned_first: false,
  page_numbers: true,
  printed_date: true,
  footer_note: "",
  filename: "",
  office_info: true,
  office_columns: 2,
  layout: "table",
  cards_per_row: 4,
  split_by: "",
  schedule: { frequency: "off", day: 1, hour: 6, recipients: [], format: "pdf" },
  column_limits: {},
  assistant_fields: [],
  margins: "normal",
  margin_custom: { top: 0.5, right: 0.5, bottom: 0.6, left: 0.5 },
  is_default: false,
};

export function DirectoryExportPanel({
  fields,
  initialListColumns,
  initialGroupBy,
  initialNameSort = "full",
  initialPresets,
  smtpConfigured = false,
  runLog = {},
}: {
  fields: DirectoryField[];
  initialListColumns: string[];
  initialGroupBy: string;
  /** What the list's Name column sorts by until a person picks for themselves. */
  initialNameSort?: NameSortMode;
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
  const assistantHelpId = useId();

  // --- list defaults ---
  const [columns, setColumns] = useState(initialListColumns);
  const [groupBy, setGroupBy] = useState(initialGroupBy);
  const [nameSort, setNameSort] = useState<NameSortMode>(initialNameSort);
  const [savingList, setSavingList] = useState(false);
  async function saveList() {
    setSavingList(true);
    const r = await jsonFetch("/api/admin/directory/list-columns", { method: "PUT", body: JSON.stringify({ columns, group_by: groupBy, name_sort: nameSort }) });
    setSavingList(false);
    if (!r.ok) {
      toast("error", r.data?.error || "Could not save.");
      return;
    }
    toast("ok", "Directory defaults saved.");
  }

  // --- presets ---
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
  // blank is "automatic" and drops the key.
  const limits = cur.column_limits ?? {};
  function setLimit(key: string, raw: string) {
    const next = { ...limits };
    if (raw === "") delete next[key];
    else next[key] = Number(raw);
    update({ column_limits: next });
  }
  const limitProblem = (p: ExportPreset) => {
    const bad = Object.entries(p.column_limits ?? {}).find(([, n]) => rangeError(n, LIMIT_MIN, LIMIT_MAX));
    return bad ? { key: bad[0], message: rangeError(bad[1], LIMIT_MIN, LIMIT_MAX)! } : undefined;
  };
  const curLimitProblem = limitProblem(cur);

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
  const invalid = presets.some((p) => limitProblem(p) || marginProblem(p));

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
    setDirty(false);
    toast("ok", "Export presets saved.");
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Directory defaults</h3>
        <p className="mb-3 text-sm text-slate-500">
          The columns the list shows before a person changes them for themselves, the field the
          Groups view opens on, and how names sort.
        </p>
        <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
          <OrderedKeyList value={columns} onChange={setColumns} available={available} />
          <div className="space-y-3">
            <Field label="Groups view opens on">
              <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="w-full">
                {groupFields.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Sort names by" help="How the list orders the Name column until a person picks for themselves.">
              <Select value={nameSort} onChange={(e) => setNameSort(e.target.value === "first" ? "first" : e.target.value === "last" ? "last" : "full")} className="w-full">
                <option value="full">Full name</option>
                <option value="first">First name</option>
                <option value="last">Last name</option>
              </Select>
            </Field>
          </div>
        </div>
        <button type="button" onClick={saveList} disabled={savingList} className={buttonClass("primary", "md", "mt-3")}>
          {savingList ? "Saving…" : "Save defaults"}
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
        <h3 className="mb-1 font-semibold text-slate-900">Export presets</h3>
        <p className="mb-3 text-sm text-slate-500">
          What comes out of <strong>Export</strong> on the Directory page: a PDF (or CSV) with these columns,
          sections, paper and branding. One preset is the default; people can also export exactly what they
          have on screen.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="w-64">
            <Select value={String(selected)} onChange={(e) => setSelected(Number(e.target.value))} aria-label="Preset">
              {presets.map((p, i) => (
                <option key={p.id} value={i}>
                  {p.name}{p.is_default ? " (default)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <button type="button" onClick={() => addPreset()} className={buttonClass("secondary")}>
            <span className="inline-flex items-center gap-1.5"><Plus className="h-4 w-4" /> New</span>
          </button>
          <button type="button" onClick={() => addPreset(cur)} className={buttonClass("secondary")}>
            <span className="inline-flex items-center gap-1.5"><Copy className="h-4 w-4" /> Duplicate</span>
          </button>
          <button type="button" onClick={removePreset} disabled={presets.length <= 1} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-red-600 hover-danger disabled:opacity-40">
            <span className="inline-flex items-center gap-1.5"><Trash2 className="h-4 w-4" /> Delete</span>
          </button>
          {!cur.is_default && (
            <button type="button" onClick={makeDefault} className={buttonClass("secondary")}>
              Make default
            </button>
          )}
          <a
            href={`/api/directory/export?preset=${encodeURIComponent(cur.id)}`}
            className={`rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 ${dirty ? "pointer-events-none opacity-40" : ""}`}
            data-tt={dirty ? "Save first to download this preset" : "Download this preset as a PDF"}
            aria-disabled={dirty}
          >
            <span className="inline-flex items-center gap-1.5"><Download className="h-4 w-4" /> Download PDF</span>
          </a>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Preset name"><TextInput value={cur.name} onChange={(e) => update({ name: e.target.value })} /></Field>
            <Field label="Document title" help="Blank = “<Company> directory”."><TextInput value={cur.title} onChange={(e) => update({ title: e.target.value })} placeholder="Phone directory" /></Field>
            <Field label="Subtitle"><TextInput value={cur.subtitle} onChange={(e) => update({ subtitle: e.target.value })} placeholder="Internal · updated weekly" /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Paper">
                <Select value={cur.paper} onChange={(e) => update({ paper: e.target.value as ExportPreset["paper"] })} className="w-full">
                  <option value="letter">Letter</option>
                  <option value="a4">A4</option>
                  <option value="legal">Legal</option>
                </Select>
              </Field>
              <Field label="Orientation">
                <Select value={cur.orientation} onChange={(e) => update({ orientation: e.target.value as ExportPreset["orientation"] })} className="w-full">
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </Select>
              </Field>
              <Field label="Density">
                <Select value={cur.density} onChange={(e) => update({ density: e.target.value as ExportPreset["density"] })} className="w-full">
                  <option value="compact">Compact</option>
                  <option value="normal">Normal</option>
                  <option value="comfortable">Comfortable</option>
                </Select>
              </Field>
            </div>
            <Field label="Margins" help="Custom is in inches, from 0.2 to 2.">
              <Select value={cur.margins ?? "normal"} onChange={(e) => update({ margins: e.target.value as ExportPreset["margins"] })} className="w-full">
                <option value="normal">Normal</option>
                <option value="narrow">Narrow</option>
                <option value="wide">Wide</option>
                <option value="custom">Custom</option>
              </Select>
            </Field>
            {cur.margins === "custom" && (
              <div className="grid grid-cols-4 gap-2">
                {MARGIN_SIDES.map((side) => (
                  <Field key={side} label={MARGIN_LABEL[side]} error={marginError(marginShown(cur, side))}>
                    <TextInput
                      type="number"
                      inputMode="decimal"
                      min={MARGIN_MIN}
                      max={MARGIN_MAX}
                      step={0.1}
                      value={marginShown(cur, side)}
                      onChange={(e) => setMargin(side, e.target.value)}
                    />
                  </Field>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Layout" help="The sheet is a table. The who's who is a grid of photo cards — name, title and the other columns under each photo.">
                <Select value={cur.layout} onChange={(e) => update({ layout: e.target.value === "cards" ? "cards" : "table" })} className="w-full">
                  <option value="table">Table (the sheet)</option>
                  <option value="cards">Photo cards (who's who)</option>
                </Select>
              </Field>
              {cur.layout === "cards" && (
                <Field label="Cards per row" help="Four suits portrait letter; five wants landscape.">
                  <Select value={String(cur.cards_per_row)} onChange={(e) => update({ cards_per_row: Number(e.target.value) as 2 | 3 | 4 | 5 })} className="w-full">
                    {[2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {cur.layout !== "cards" && (
            <Field label="Page layout" help="Two or three columns suit a short table — name and extension — that would otherwise run down the left of an empty page. Values are cut to one line; three columns want landscape or very few columns.">
              <Select value={String(cur.page_columns)} onChange={(e) => update({ page_columns: e.target.value === "3" ? 3 : e.target.value === "2" ? 2 : 1 })} className="w-full">
                <option value="1">One table across the page</option>
                <option value="2">Two columns, side by side</option>
                <option value="3">Three columns, side by side</option>
              </Select>
            </Field>
            )}
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {cur.layout !== "cards" && <Toggle label="Shade alternate rows" checked={cur.zebra} onChange={(v) => update({ zebra: v })} />}
              <Toggle label="Workspace logo" checked={cur.logo} onChange={(v) => update({ logo: v })} />
              <Toggle label="Photos" checked={cur.photos} onChange={(v) => update({ photos: v })} />
              <Toggle label="Pinned people first" checked={cur.pinned_first} onChange={(v) => update({ pinned_first: v })} />
              <Toggle label="Page numbers" checked={cur.page_numbers} onChange={(v) => update({ page_numbers: v })} />
              <Toggle label="Printed date" checked={cur.printed_date} onChange={(v) => update({ printed_date: v })} />
              <Toggle label="Office information" help="Closes the PDF with the profile of every office that appears in it — set up under Offices." checked={cur.office_info} onChange={(v) => update({ office_info: v })} />
            </div>
            {cur.office_info && (
              <Field label="Office blocks per row" help="Side by side at the end of the PDF. One per row lays a block's fields two abreast.">
                <Select value={String(cur.office_columns)} onChange={(e) => update({ office_columns: Number(e.target.value) as 1 | 2 | 3 | 4 })} className="w-full">
                  <option value="1">One, full width</option>
                  <option value="2">Two</option>
                  <option value="3">Three</option>
                  <option value="4">Four</option>
                </Select>
              </Field>
            )}
            <Field label="Footer note" help="e.g. “Internal use only — do not distribute”."><TextInput value={cur.footer_note} onChange={(e) => update({ footer_note: e.target.value })} /></Field>
            <Field label="File name" help="Without extension; blank derives one from the title."><TextInput value={cur.filename} onChange={(e) => update({ filename: e.target.value })} placeholder="phone-directory" /></Field>
          </div>
          <div className="space-y-3">
            <Field
              label="Columns, in order"
              help={cur.layout !== "cards" ? "Wrap after: characters per line in this column; longer values wrap onto the next line. Blank lets the column size itself." : undefined}
              error={curLimitProblem ? `Wrap after for ${columnLabelOf(curLimitProblem.key)}: ${curLimitProblem.message.charAt(0).toLowerCase()}${curLimitProblem.message.slice(1)}` : undefined}
            >
              <OrderedKeyList
                value={cur.columns}
                onChange={(columns) => update({ columns })}
                available={available}
                extra={
                  cur.layout !== "cards"
                    ? (key, label) => (
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                          Wrap after
                          <TextInput
                            type="number"
                            inputMode="numeric"
                            min={LIMIT_MIN}
                            max={LIMIT_MAX}
                            step={1}
                            dense
                            className="w-16 text-xs"
                            placeholder="Auto"
                            value={limits[key] ?? ""}
                            onChange={(e) => setLimit(key, e.target.value)}
                            hasError={Boolean(rangeError(limits[key] ?? LIMIT_MIN, LIMIT_MIN, LIMIT_MAX))}
                            aria-label={`Wrap ${label} after`}
                          />
                        </span>
                      )
                    : undefined
                }
              />
            </Field>
            {cur.columns.includes("assistant") && (
              <fieldset aria-describedby={assistantHelpId}>
                <legend className="mb-1 block text-xs font-medium text-slate-500">Assistant details</legend>
                <div className="grid gap-x-3 rounded-lg border border-slate-200 p-1 sm:grid-cols-2">
                  {assistantFieldOptions.map((c) => (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm text-slate-700 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={(cur.assistant_fields ?? []).includes(c.key)}
                        onChange={(e) => toggleAssistantField(c.key, e.target.checked)}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                <p id={assistantHelpId} className="mt-1 text-xs text-slate-500">Shown after each assistant's name, e.g. phone and extension.</p>
              </fieldset>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Sections by">
                <Select value={cur.group_by} onChange={(e) => update({ group_by: e.target.value })} className="w-full">
                  <option value="">— one list —</option>
                  {groupFields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Sort by" help="Any field, synced or typed; a field with options sorts in their order.">
                <div className="flex gap-1">
                  <Select value={cur.sort} onChange={(e) => update({ sort: e.target.value, ...(cur.sort2 === e.target.value ? { sort2: "" } : {}) })} className="w-full">
                    {sortGroups.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.keys.map((c) => (
                          <option key={c.key} value={c.key}>{c.label}</option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                  <Select value={cur.sort_dir} onChange={(e) => update({ sort_dir: e.target.value as "asc" | "desc" })} className="w-20" aria-label="Direction">
                    <option value="asc">A→Z</option>
                    <option value="desc">Z→A</option>
                  </Select>
                </div>
              </Field>
            </div>
            <Field label="Then by" help="Breaks ties in the first sort — Office, then Title. Name always comes last.">
              <div className="flex gap-1">
                <Select value={cur.sort2} onChange={(e) => update({ sort2: e.target.value })} className="w-full">
                  <option value="">— nothing —</option>
                  {sortGroups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.keys.filter((c) => c.key !== cur.sort).map((c) => (
                        <option key={c.key} value={c.key}>{c.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
                <Select value={cur.sort2_dir} onChange={(e) => update({ sort2_dir: e.target.value as "asc" | "desc" })} className="w-20" aria-label="Direction of the second sort" disabled={!cur.sort2}>
                  <option value="asc">A→Z</option>
                  <option value="desc">Z→A</option>
                </Select>
              </div>
            </Field>
            <Field label="One file per" help="Instead of one document, a zip with one for each value — every office its own sheet. Each file's title carries the value.">
              <Select value={cur.split_by} onChange={(e) => update({ split_by: e.target.value })} className="w-full">
                <option value="">— one file —</option>
                {groupFields.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </Select>
            </Field>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-sm font-medium text-slate-800">Email it on a schedule</p>
              <p className="mb-3 text-xs text-slate-500">
                {smtpConfigured
                  ? "The file this preset makes, sent as an attachment — a monthly directory to the office managers, a weekly who's who to reception."
                  : <>SMTP is not set up (<SettingsLink href="/admin/notifications/email" />); the schedule is kept but nothing is sent until it is.</>}
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="How often">
                  <Select value={cur.schedule.frequency} onChange={(e) => updateSchedule({ frequency: e.target.value as ExportSchedule["frequency"], day: e.target.value === "weekly" ? 1 : 1 })} className="w-full">
                    <option value="off">Never</option>
                    <option value="weekly">Every week</option>
                    <option value="monthly">Every month</option>
                  </Select>
                </Field>
                <Field label={cur.schedule.frequency === "monthly" ? "Day of the month" : "Day"}>
                  <Select value={String(cur.schedule.day)} onChange={(e) => updateSchedule({ day: Number(e.target.value) })} className="w-full" disabled={cur.schedule.frequency === "off"}>
                    {cur.schedule.frequency === "monthly"
                      ? Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)
                      : WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
                  </Select>
                </Field>
                <Field label="At (UTC)">
                  <Select value={String(cur.schedule.hour)} onChange={(e) => updateSchedule({ hour: Number(e.target.value) })} className="w-full" disabled={cur.schedule.frequency === "off"}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                  </Select>
                </Field>
                <Field label="As">
                  <Select value={cur.schedule.format} onChange={(e) => updateSchedule({ format: e.target.value === "csv" ? "csv" : "pdf" })} className="w-full" disabled={cur.schedule.frequency === "off"}>
                    <option value="pdf">PDF</option>
                    <option value="csv">CSV</option>
                  </Select>
                </Field>
              </div>
              <div className="mt-3">
                <Field label="Send to" help="Comma-separated email addresses.">
                  <TextInput
                    value={recipientsText[cur.id] ?? cur.schedule.recipients.join(", ")}
                    onChange={(e) => setRecipientsText({ ...recipientsText, [cur.id]: e.target.value })}
                    onBlur={(e) => updateSchedule({ recipients: e.target.value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean) })}
                    placeholder="office-manager@firm.com, reception@firm.com"
                    disabled={cur.schedule.frequency === "off"}
                  />
                </Field>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {describeSchedule(cur.schedule)}
                {cur.schedule.frequency !== "off" && cur.schedule.recipients.length === 0 ? " — add a recipient." : ""}
                {runLog[cur.id] ? ` · Last ${runLog[cur.id].ok ? "sent" : "failed"} ${new Date(runLog[cur.id].at).toUTCString().replace(/:\d\d GMT$/, " UTC")}${runLog[cur.id].detail ? ` (${runLog[cur.id].detail})` : ""}` : ""}
              </p>
            </div>
            <Field label="Only people where" help="e.g. Office = PHX1 for one office's sheet. Leave blank for everyone.">
              <div className="flex gap-1">
                <Select value={cur.filter?.key ?? ""} onChange={(e) => update({ filter: e.target.value ? { key: e.target.value, value: cur.filter?.value ?? "" } : null })} className="w-40" aria-label="Filter field">
                  <option value="">— none —</option>
                  {available.filter((c) => c.key !== "name").map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </Select>
                <TextInput className="flex-1" value={cur.filter?.value ?? ""} placeholder="value" disabled={!cur.filter} onChange={(e) => update({ filter: cur.filter ? { ...cur.filter, value: e.target.value } : null })} aria-label="Filter value" />
              </div>
            </Field>
          </div>
        </div>
        <SaveRow dirty={dirty} busy={savingPresets} onSave={savePresets} label="Save presets" disabled={invalid} className="mt-4" />
      </div>
    </div>
  );
}

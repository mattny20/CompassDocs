"use client";

// The right pane of the Export page: the selected preset's name and actions,
// then its controls in five cards, each one job: what the document is called,
// how the page is set, which columns it carries, who is in it and in what
// order, and whether it emails itself. The state and the rules live in
// DirectoryExportPanel (the Save row waits on every preset, not just this
// one); this file only lays the controls out.

import { useId } from "react";
import { Copy, Download, Trash2 } from "lucide-react";
import { Card } from "@/components/Card";
import { CardTitle } from "@/components/Heading";
import { chipClass } from "@/components/Chip";
import { Button, buttonClass } from "@/components/Button";
import { SettingsLink } from "@/components/SettingsLink";
import { Field, Select, TextInput, Toggle, rangeError } from "@/components/form";
import type { DirectoryField } from "@/lib/directory";
import type { ExportPreset } from "@/lib/directory-export-config";
import { describeSchedule, WEEKDAYS, type ExportSchedule } from "@/lib/directory-export-schedule-rules";
import { OrderedKeyList, type KeyOption } from "../shared";
import { LIMIT_MAX, LIMIT_MIN, MARGIN_LABEL, MARGIN_MAX, MARGIN_MIN, MARGIN_SIDES, marginError, type MarginSide } from "./preset-rules";

/** Everything the editor reads and calls; built by DirectoryExportPanel. */
export interface PresetEditorModel {
  cur: ExportPreset;
  update: (patch: Partial<ExportPreset>) => void;
  updateSchedule: (patch: Partial<ExportSchedule>) => void;
  available: KeyOption[];
  groupFields: DirectoryField[];
  sortGroups: { label: string; keys: KeyOption[] }[];
  assistantFieldOptions: KeyOption[];
  toggleAssistantField: (key: string, on: boolean) => void;
  /** "Wrap after", per column key, as typed. */
  limits: Record<string, number>;
  setLimit: (key: string, raw: string) => void;
  touchLimit: (key: string) => void;
  limitTouched: (key: string) => boolean;
  /** The help under the columns list, or the first touched row's error. */
  columnsNote?: string;
  columnsNoteIsError: boolean;
  marginShown: (side: MarginSide) => string;
  setMargin: (side: MarginSide, raw: string) => void;
  /** The recipients box as typed, until it is left. */
  recipientsText?: string;
  setRecipientsText: (text: string) => void;
  commitRecipients: (raw: string) => void;
  smtpConfigured: boolean;
  lastRun?: { at: string; ok: boolean; detail?: string };
}

export function PresetEditor({
  model,
  dirty,
  canDelete,
  onMakeDefault,
  onDuplicate,
  onDelete,
}: {
  model: PresetEditorModel;
  /** Unsaved changes on the page: the download waits for a save. */
  dirty: boolean;
  canDelete: boolean;
  onMakeDefault: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { cur } = model;
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <CardTitle as="h2" className="min-w-0">
            <span className="min-w-0 truncate">{cur.name || "Untitled preset"}</span>
          </CardTitle>
          {cur.is_default && <span className={chipClass("info", "sm")}>Default</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!cur.is_default && (
            <Button variant="secondary" onClick={onMakeDefault}>
              Make default
            </Button>
          )}
          <Button variant="secondary" icon={<Copy />} onClick={onDuplicate}>
            Duplicate
          </Button>
          <a
            href={`/api/directory/export?preset=${encodeURIComponent(cur.id)}`}
            className={buttonClass("secondary", "md", dirty ? "pointer-events-none opacity-40" : "")}
            data-tt={dirty ? "Save first to download this preset" : "Download this preset as a PDF"}
            aria-disabled={dirty}
          >
            <Download className="h-4 w-4" aria-hidden /> Download PDF
          </a>
          <Button variant="danger" icon={<Trash2 />} onClick={onDelete} disabled={!canDelete}>
            Delete
          </Button>
        </div>
      </div>
      <DocumentCard m={model} />
      <PageCard m={model} />
      <ColumnsCard m={model} />
      <OrderCard m={model} />
      <ScheduleCard m={model} />
    </div>
  );
}

function DocumentCard({ m }: { m: PresetEditorModel }) {
  const { cur, update } = m;
  return (
    <Card id="document" className="scroll-mt-6" title="Document" description="What the preset is called, and what the file says at the top and bottom.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Preset name"><TextInput value={cur.name} onChange={(e) => update({ name: e.target.value })} /></Field>
        <Field label="Document title" help="Blank = “<Company> directory”."><TextInput value={cur.title} onChange={(e) => update({ title: e.target.value })} placeholder="Phone directory" /></Field>
        <Field label="Subtitle"><TextInput value={cur.subtitle} onChange={(e) => update({ subtitle: e.target.value })} placeholder="Internal · updated weekly" /></Field>
        <Field label="Footer note" help="e.g. “Internal use only — do not distribute”."><TextInput value={cur.footer_note} onChange={(e) => update({ footer_note: e.target.value })} /></Field>
        <Field label="File name" help="Without extension; blank derives one from the title."><TextInput value={cur.filename} onChange={(e) => update({ filename: e.target.value })} placeholder="phone-directory" /></Field>
      </div>
      <div className="mt-3">
        <Toggle label="Workspace logo" checked={cur.logo} onChange={(v) => update({ logo: v })} />
      </div>
    </Card>
  );
}

function PageCard({ m }: { m: PresetEditorModel }) {
  const { cur, update } = m;
  return (
    <Card id="page" className="scroll-mt-6" title="Page" description="Paper, margins, and how the people are laid out on it.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2 sm:grid-cols-3">
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
        <Field label="Margins" help="Custom is in inches, from 0.2 to 2, a tenth at a time.">
          <Select value={cur.margins ?? "normal"} onChange={(e) => update({ margins: e.target.value as ExportPreset["margins"] })} className="w-full">
            <option value="normal">Normal</option>
            <option value="narrow">Narrow</option>
            <option value="wide">Wide</option>
            <option value="custom">Custom</option>
          </Select>
        </Field>
      </div>
      {cur.margins === "custom" && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MARGIN_SIDES.map((side) => (
            <Field key={side} label={MARGIN_LABEL[side]} error={marginError(m.marginShown(side))}>
              <TextInput
                type="number"
                inputMode="decimal"
                min={MARGIN_MIN}
                max={MARGIN_MAX}
                step={0.1}
                value={m.marginShown(side)}
                onChange={(e) => m.setMargin(side, e.target.value)}
              />
            </Field>
          ))}
        </div>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Layout" help="The sheet is a table. The who's who is a grid of photo cards — name, title and the other columns under each photo.">
          <Select value={cur.layout} onChange={(e) => update({ layout: e.target.value === "cards" ? "cards" : "table" })} className="w-full">
            <option value="table">Table (the sheet)</option>
            <option value="cards">Photo cards (who's who)</option>
          </Select>
        </Field>
        {cur.layout === "cards" ? (
          <Field label="Cards per row" help="Four suits portrait letter; five wants landscape.">
            <Select value={String(cur.cards_per_row)} onChange={(e) => update({ cards_per_row: Number(e.target.value) as 2 | 3 | 4 | 5 })} className="w-full">
              {[2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Page layout" help="Two or three columns suit a short table that would otherwise run down the left of an empty page. Values are cut to one line unless the column has a Wrap after limit; three columns want landscape or very few columns.">
            <Select value={String(cur.page_columns)} onChange={(e) => update({ page_columns: e.target.value === "3" ? 3 : e.target.value === "2" ? 2 : 1 })} className="w-full">
              <option value="1">One table across the page</option>
              <option value="2">Two columns, side by side</option>
              <option value="3">Three columns, side by side</option>
            </Select>
          </Field>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {cur.layout !== "cards" && <Toggle label="Shade alternate rows" checked={cur.zebra} onChange={(v) => update({ zebra: v })} />}
        <Toggle label="Page numbers" checked={cur.page_numbers} onChange={(v) => update({ page_numbers: v })} />
        <Toggle label="Printed date" checked={cur.printed_date} onChange={(v) => update({ printed_date: v })} />
      </div>
    </Card>
  );
}

function ColumnsCard({ m }: { m: PresetEditorModel }) {
  const { cur, update } = m;
  const assistantHelpId = useId();
  const columnsHelpId = useId();
  return (
    <Card id="columns" className="scroll-mt-6" title="Columns" description="What each person's row carries, in order, and what goes with it.">
      <div className="space-y-3">
        {/* A fieldset, not a Field: a Field's label would hand a click on
            any text in the list to the first row's Wrap after input. */}
        <fieldset aria-describedby={m.columnsNote ? columnsHelpId : undefined}>
          <legend className="mb-1 block text-xs font-medium text-slate-500">Columns, in order</legend>
          <OrderedKeyList
            value={cur.columns}
            onChange={(columns) => update({ columns })}
            available={m.available}
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
                        value={m.limits[key] ?? ""}
                        onChange={(e) => m.setLimit(key, e.target.value)}
                        onBlur={() => m.touchLimit(key)}
                        hasError={Boolean(m.limitTouched(key) && rangeError(m.limits[key] ?? LIMIT_MIN, LIMIT_MIN, LIMIT_MAX))}
                        aria-label={`Wrap ${label} after`}
                      />
                    </span>
                  )
                : undefined
            }
          />
          {m.columnsNote && (
            <p
              id={columnsHelpId}
              role={m.columnsNoteIsError ? "alert" : undefined}
              className={m.columnsNoteIsError ? "mt-1 text-xs text-red-600" : "mt-1 text-xs text-slate-500"}
            >
              {m.columnsNote}
            </p>
          )}
        </fieldset>
        {cur.columns.includes("assistant") && (
          <fieldset aria-describedby={assistantHelpId}>
            <legend className="mb-1 block text-xs font-medium text-slate-500">Assistant details</legend>
            <div className="grid gap-x-3 rounded-lg border border-slate-200 p-1 sm:grid-cols-2">
              {m.assistantFieldOptions.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm text-slate-700 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={(cur.assistant_fields ?? []).includes(c.key)}
                    onChange={(e) => m.toggleAssistantField(c.key, e.target.checked)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
            <p id={assistantHelpId} className="mt-1 text-xs text-slate-500">Shown after each assistant's name, e.g. phone and extension.</p>
          </fieldset>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Toggle label="Photos" checked={cur.photos} onChange={(v) => update({ photos: v })} />
          <Toggle label="Pinned people first" checked={cur.pinned_first} onChange={(v) => update({ pinned_first: v })} />
          <Toggle label="Office information" help="Closes the PDF with the profile of every office that appears in it — set up under Offices." checked={cur.office_info} onChange={(v) => update({ office_info: v })} />
        </div>
        {cur.office_info && (
          <Field label="Office blocks per row" help="Side by side at the end of the PDF. One per row lays a block's fields two abreast." size="sm">
            <Select value={String(cur.office_columns)} onChange={(e) => update({ office_columns: Number(e.target.value) as 1 | 2 | 3 | 4 })} className="w-full">
              <option value="1">One, full width</option>
              <option value="2">Two</option>
              <option value="3">Three</option>
              <option value="4">Four</option>
            </Select>
          </Field>
        )}
      </div>
    </Card>
  );
}

function OrderCard({ m }: { m: PresetEditorModel }) {
  const { cur, update } = m;
  return (
    <Card id="order" className="scroll-mt-6" title="Order and filter" description="Who is in the file, in which sections, and in what order.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sections by">
          <Select value={cur.group_by} onChange={(e) => update({ group_by: e.target.value })} className="w-full">
            <option value="">— one list —</option>
            {m.groupFields.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Sort by" help="Any field, synced or typed; a field with options sorts in their order.">
          <div className="flex gap-1">
            <Select value={cur.sort} onChange={(e) => update({ sort: e.target.value, ...(cur.sort2 === e.target.value ? { sort2: "" } : {}) })} className="w-full">
              {m.sortGroups.map((g) => (
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
        <Field label="Then by" help="Breaks ties in the first sort — Office, then Title. Name always comes last.">
          <div className="flex gap-1">
            <Select value={cur.sort2} onChange={(e) => update({ sort2: e.target.value })} className="w-full">
              <option value="">— nothing —</option>
              {m.sortGroups.map((g) => (
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
        <Field label="Only people where" help="e.g. Office = PHX1 for one office's sheet. Leave blank for everyone.">
          <div className="flex gap-1">
            <Select value={cur.filter?.key ?? ""} onChange={(e) => update({ filter: e.target.value ? { key: e.target.value, value: cur.filter?.value ?? "" } : null })} className="w-40" aria-label="Filter field">
              <option value="">— none —</option>
              {m.available.filter((c) => c.key !== "name").map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </Select>
            <TextInput className="flex-1" value={cur.filter?.value ?? ""} placeholder="value" disabled={!cur.filter} onChange={(e) => update({ filter: cur.filter ? { ...cur.filter, value: e.target.value } : null })} aria-label="Filter value" />
          </div>
        </Field>
        <Field label="One file per" help="Instead of one document, a zip with one for each value — every office its own sheet. Each file's title carries the value.">
          <Select value={cur.split_by} onChange={(e) => update({ split_by: e.target.value })} className="w-full">
            <option value="">— one file —</option>
            {m.groupFields.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

function ScheduleCard({ m }: { m: PresetEditorModel }) {
  const { cur, updateSchedule } = m;
  const off = cur.schedule.frequency === "off";
  return (
    <Card
      id="schedule"
      className="scroll-mt-6"
      title="Schedule"
      description={
        m.smtpConfigured
          ? "The file this preset makes, sent as an attachment — a monthly directory to the office managers, a weekly who's who to reception."
          : undefined
      }
    >
      {!m.smtpConfigured && (
        <div className="notice-warn mb-3 rounded-lg border px-3 py-2 text-sm">
          SMTP is not set up (<SettingsLink href="/admin/notifications/email" />); the schedule is kept but nothing is sent until it is.
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="How often">
          <Select value={cur.schedule.frequency} onChange={(e) => updateSchedule({ frequency: e.target.value as ExportSchedule["frequency"], day: e.target.value === "weekly" ? 1 : 1 })} className="w-full">
            <option value="off">Never</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </Select>
        </Field>
        <Field label={cur.schedule.frequency === "monthly" ? "Day of the month" : "Day"}>
          <Select value={String(cur.schedule.day)} onChange={(e) => updateSchedule({ day: Number(e.target.value) })} className="w-full" disabled={off}>
            {cur.schedule.frequency === "monthly"
              ? Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)
              : WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
          </Select>
        </Field>
        <Field label="At (UTC)">
          <Select value={String(cur.schedule.hour)} onChange={(e) => updateSchedule({ hour: Number(e.target.value) })} className="w-full" disabled={off}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
          </Select>
        </Field>
        <Field label="As">
          <Select value={cur.schedule.format} onChange={(e) => updateSchedule({ format: e.target.value === "csv" ? "csv" : "pdf" })} className="w-full" disabled={off}>
            <option value="pdf">PDF</option>
            <option value="csv">CSV</option>
          </Select>
        </Field>
      </div>
      <Field label="Send to" help="Comma-separated email addresses." size="lg" className="mt-3">
        <TextInput
          value={m.recipientsText ?? cur.schedule.recipients.join(", ")}
          onChange={(e) => m.setRecipientsText(e.target.value)}
          onBlur={(e) => m.commitRecipients(e.target.value)}
          placeholder="office-manager@firm.com, reception@firm.com"
          disabled={off}
        />
      </Field>
      <p className="mt-2 text-xs text-slate-500">
        {describeSchedule(cur.schedule)}
        {cur.schedule.frequency !== "off" && cur.schedule.recipients.length === 0 ? " — add a recipient." : ""}
        {m.lastRun ? ` · Last ${m.lastRun.ok ? "sent" : "failed"} ${new Date(m.lastRun.at).toUTCString().replace(/:\d\d GMT$/, " UTC")}${m.lastRun.detail ? ` (${m.lastRun.detail})` : ""}` : ""}
      </p>
    </Card>
  );
}
